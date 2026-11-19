// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_token_policy.h"

#include <array>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_host_visibility.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_file_picker.h"
#include "chrome/browser/ardia/ac_cli_owned_tabs.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

constexpr std::array<std::pair<std::string_view, CommandDomain>, 11>
    kCountedDomains = {{
        {"Target", CommandDomain::kTarget},
        {"Page", CommandDomain::kPage},
        {"Runtime", CommandDomain::kRuntime},
        {"DOM", CommandDomain::kDom},
        {"Input", CommandDomain::kInput},
        {"Network", CommandDomain::kNetwork},
        {"Emulation", CommandDomain::kEmulation},
        {"Browser", CommandDomain::kBrowser},
        {"Storage", CommandDomain::kStorage},
        {"Fetch", CommandDomain::kFetch},
        {"Accessibility", CommandDomain::kAccessibility},
    }};

constexpr std::array<std::string_view, static_cast<size_t>(CommandDomain::kCount)>
    kDomainNames = {"target",  "page",      "runtime", "dom",
                    "input",   "network",   "emulation", "browser",
                    "storage", "fetch",     "accessibility", "other"};

std::array<int, static_cast<size_t>(CommandDomain::kCount)>& CommandCounts() {
  static std::array<int, static_cast<size_t>(CommandDomain::kCount)> counts =
      {};
  return counts;
}

bool NeedsResponse(const std::string& method) {
  return method == "Target.getTargets" || method == "Target.getTargetInfo" ||
         method == "Target.createTarget";
}

std::vector<TokenClient*> ClientsOf(const std::string& credential_id) {
  std::vector<TokenClient*> clients;
  for (const auto& [root, client] : Registry()) {
    if (client->scope() && client->scope()->credential_id == credential_id) {
      clients.push_back(client);
    }
  }
  return clients;
}

void MarkOffscreen(base::DictValue* info) {
  if (info && IsOffscreenTarget(info->FindString("targetId"))) {
    info->Set("ardiaOffscreen", true);
  }
}

}

CommandDomain DomainOf(std::string_view method) {
  const std::string_view domain = method.substr(0, method.find('.'));
  for (const auto& [name, counted] : kCountedDomains) {
    if (name == domain) {
      return counted;
    }
  }
  return CommandDomain::kOther;
}

void CountCommand(CommandDomain domain) {
  int& count = CommandCounts()[static_cast<size_t>(domain)];
  if (count < std::numeric_limits<int>::max()) {
    ++count;
  }
}

bool IsOffscreenTarget(const std::string* target_id) {
  content::DevToolsAgentHost* host =
      target_id ? content::ArdiaDevToolsAgentHostForId(*target_id) : nullptr;
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  return contents && ardiacore::InAutomationWindow(contents);
}

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message) {
  base::DictValue error;
  error.Set("code", code);
  error.Set("message", message);
  base::DictValue reply;
  reply.Set("id", id);
  if (!session.empty()) {
    reply.Set("sessionId", session);
  }
  reply.Set("error", std::move(error));
  return base::WriteJson(reply).value_or("{}");
}

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry() {
  static base::NoDestructor<
      std::map<content::DevToolsAgentHostClient*, TokenClient*>>
      registry;
  return *registry;
}

TokenClient::TokenClient(content::DevToolsAgentHostClient* client,
                         content::DevToolsAgentHost* host,
                         TokenKind kind,
                         std::optional<PluginScope> scope)
    : client_(client),
      root_host_(host),
      kind_(kind),
      scope_(std::move(scope)) {
  CHECK_EQ(kind_ == TokenKind::kPlugin, scope_.has_value());
  Registry()[client_] = this;
}

void TokenClient::Revoke() {
  wedged_ = true;
  if (closer_) {
    std::move(closer_).Run();
  }
}

void TokenClient::SetCloser(base::OnceClosure close) {
  closer_ = std::move(close);
}

bool TokenClient::MayAttachToURL(const GURL& url, bool is_webui) {
  return kind_ == TokenKind::kCli || (!is_webui && IsWebUrl(url));
}

bool TokenClient::MayAttachToRenderFrameHost(content::RenderFrameHost* frame) {
  return kind_ == TokenKind::kCli || PluginMayAttachToFrame(*scope_, frame);
}

bool TokenClient::MayReadLocalFiles() {
  return kind_ == TokenKind::kCli;
}

bool TokenClient::MayWriteLocalFiles() {
  return kind_ == TokenKind::kCli;
}

TokenClient::~TokenClient() {
  Registry().erase(client_);
  ForgetFilePickerAnswers(this);
  ReleaseCliOwnedTargets(this);
}

bool TokenClient::FilterCommand(std::string& message, std::string* reply) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    *reply = ErrorReply(0, std::string(), kParseError,
                        "ardia: a command must be a JSON object");
    return false;
  }
  base::DictValue& command = parsed->GetDict();
  const std::string* session_id = command.FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  std::optional<int> id = command.FindInt("id");
  const std::string* method = command.FindString("method");
  if (!id || !method || (command.Find("sessionId") && !session_id)) {
    *reply = ErrorReply(id.value_or(0), session, kInvalidRequest,
                        "ardia: a command needs an id and a method");
    return false;
  }
  if (session_id && !targets_.contains(session)) {
    *reply = ErrorReply(*id, std::string(), kInvalidRequest,
                        "ardia: no attached session has that sessionId");
    return false;
  }
  if (command.Find("params") && !command.FindDict("params")) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "ardia: params must be an object");
    return false;
  }
  if (wedged_) {
    *reply = ErrorReply(*id, session, kRefused,
                        "ardia: this connection is closing");
    return false;
  }
  if (kind_ == TokenKind::kPlugin) {
    const base::DictValue empty;
    const base::DictValue* params = command.FindDict("params");
    const std::string refusal =
        PluginRefusal(*scope_, *method, params ? *params : empty,
                      session.empty());
    if (!refusal.empty()) {
      ++PluginTotalsSoFar().refused;
      *reply = ErrorReply(*id, session, kMethodNotAllowed,
                          base::StrCat({"ardia: ", *method, " ", refusal,
                                        " isn't allowed for a plugin"}));
      return false;
    }
  }
  if (*method == kAnswerFilePicker) {
    return AnswerFilePickerCommand(*id, session, command.FindDict("params"),
                                   reply);
  }
  const std::pair<std::string, int> key(session, *id);
  if (outstanding_.contains(key)) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "ardia: a command with that id is still waiting for "
                        "its reply");
    return false;
  }
  if (outstanding_.size() >= kMaxPending) {
    *reply = ErrorReply(*id, session, kRefused,
                        "ardia: too many commands are waiting for replies; "
                        "closing the connection");
    wedged_ = true;
    return false;
  }
  NoteCommand(*method, session, command.FindDict("params"));
  outstanding_[key] = NeedsResponse(*method) ? *method : std::string();
  message = base::WriteJson(command).value_or(std::string());
  return !message.empty();
}

bool TokenClient::AnswerFilePickerCommand(int id,
                                          const std::string& session,
                                          const base::DictValue* params,
                                          std::string* reply) {
  CountCommand(CommandDomain::kOther);
  auto target = targets_.find(session);
  content::DevToolsAgentHost* host =
      target == targets_.end()
          ? nullptr
          : content::ArdiaDevToolsAgentHostForId(target->second);
  const base::DictValue empty;
  const std::string refusal = ArmFilePickerAnswer(
      host ? host->GetWebContents() : nullptr, params ? *params : empty, this);
  if (!refusal.empty()) {
    *reply = ErrorReply(id, session, kInvalidRequest,
                        base::StrCat({"ardia: ", kAnswerFilePicker, " ",
                                      refusal, " can't be answered"}));
    return false;
  }
  base::DictValue answer;
  answer.Set("id", id);
  if (!session.empty()) {
    answer.Set("sessionId", session);
  }
  answer.Set("result", base::DictValue());
  *reply = base::WriteJson(answer).value_or("{}");
  return false;
}

bool TokenClient::ShouldClose() const {
  return wedged_;
}

void TokenClient::NoteCommand(const std::string& method,
                              const std::string& session,
                              const base::DictValue* params) {
  CountCommand(DomainOf(method));
  if (method != "Emulation.setDeviceMetricsOverride") {
    return;
  }
  auto target = targets_.find(session);
  if (target != targets_.end()) {
    ClaimCliOwnedTarget(target->second, this);
  }
}

bool TokenClient::FilterResponse(const std::string& method,
                                 std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  base::DictValue* result =
      parsed && parsed->is_dict() ? parsed->GetDict().FindDict("result")
                                  : nullptr;
  if (!result) {
    return true;
  }
  if (method == "Target.createTarget") {
    if (const std::string* target_id = result->FindString("targetId")) {
      NoteCliOwnedTarget(*target_id, this);
    }
    return true;
  }
  if (method == "Target.getTargets") {
    base::ListValue* infos = result->FindList("targetInfos");
    if (!infos) {
      return true;
    }
    if (kind_ == TokenKind::kPlugin) {
      infos->EraseIf([&](const base::Value& info) {
        return !info.is_dict() ||
               !PluginMayAttachToTargetId(*scope_,
                                          info.GetDict().FindString("targetId"));
      });
    }
    for (base::Value& info : *infos) {
      MarkOffscreen(info.GetIfDict());
    }
  } else {
    MarkOffscreen(result->FindDict("targetInfo"));
  }
  std::optional<std::string> annotated = base::WriteJson(*parsed);
  if (annotated) {
    message = std::move(*annotated);
  }
  return true;
}

}

std::unique_ptr<ArdiaDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host,
    TokenKind kind,
    std::optional<PluginScope> scope) {
  if ((kind == TokenKind::kPlugin) != scope.has_value() ||
      (scope && !PluginMayConnectTo(*scope, host))) {
    return nullptr;
  }
  return std::make_unique<cli_token_policy_internal::TokenClient>(
      client, host, kind, std::move(scope));
}

std::optional<TokenKind> TokenClientKind(
    content::DevToolsAgentHostClient* root_client) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end()) {
    return std::nullopt;
  }
  return it->second->kind();
}

bool IsTokenClient(content::DevToolsAgentHostClient* root_client) {
  return TokenClientKind(root_client).has_value();
}

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() == TokenKind::kCli) {
    return true;
  }
  return host == it->second->root_host() ||
         cli_token_policy_internal::PluginTargetInScope(*it->second->scope(),
                                                        host);
}

void CloseTokenClientsOf(const std::string& credential_id) {
  for (cli_token_policy_internal::TokenClient* client :
       cli_token_policy_internal::ClientsOf(credential_id)) {
    client->Revoke();
  }
}

PluginTotals& PluginTotalsSoFar() {
  static PluginTotals totals;
  return totals;
}

base::DictValue TokenCommandsByDomain() {
  base::DictValue counts;
  for (size_t i = 0; i < cli_token_policy_internal::kDomainNames.size(); ++i) {
    counts.Set(cli_token_policy_internal::kDomainNames[i],
               cli_token_policy_internal::CommandCounts()[i]);
  }
  return counts;
}

}

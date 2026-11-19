// Copyright 2026 Ardia. Apache-2.0.

#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_process_host.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

std::string OutOfScopeReply(int id, const std::string& session) {
  return ErrorReply(id, session, kRefused,
                    base::StrCat({kOutOfScope,
                                  ": the tab left the plugin's window"}));
}

bool IsBrowserHost(content::DevToolsAgentHost* host) {
  return host && host->GetType() == content::DevToolsAgentHost::kTypeBrowser;
}

}

content::DevToolsAgentHost* TokenClient::HostOf(const std::string& session) {
  if (session.empty()) {
    return root_host_.get();
  }
  auto it = targets_.find(session);
  return it == targets_.end()
             ? nullptr
             : content::ArdiaDevToolsAgentHostForId(it->second);
}

int TokenClient::ProcessOf(const std::string& session) {
  content::DevToolsAgentHost* host = HostOf(session);
  content::RenderProcessHost* process = host ? host->GetProcessHost() : nullptr;
  return process ? process->GetDeprecatedID() : -1;
}

void TokenClient::AllowContext(const std::string& session, int context) {
  const int process = ProcessOf(session);
  if (process >= 0) {
    contexts_[session].ids[context] = process;
  }
}

bool TokenClient::ContextAllowed(const std::string& session,
                                 std::optional<int> context) {
  auto found = contexts_.find(session);
  if (!context || found == contexts_.end()) {
    return false;
  }
  auto it = found->second.ids.find(*context);
  return it != found->second.ids.end() && it->second == ProcessOf(session);
}

bool TokenClient::SessionInScope(const std::string& session) {
  auto it = targets_.find(session);
  return it != targets_.end() && PluginMayAttachToTargetId(*scope_, &it->second);
}

bool TokenClient::PluginCommandAllowed(int id,
                                       const std::string& session,
                                       const std::string& method,
                                       base::DictValue& params,
                                       std::string* reply) {
  if (!session.empty() && !SessionInScope(session)) {
    *reply = OutOfScopeReply(id, session);
    DetachOutOfScope(session);
    return false;
  }
  if (session.empty() && !IsBrowserHost(root_host_.get()) &&
      !PluginTargetInScope(*scope_, root_host_.get())) {
    *reply = OutOfScopeReply(id, session);
    CloseOutOfScope();
    return false;
  }
  PluginCommandContext context;
  context.on_root_session = session.empty();
  context.context_allowed = base::BindRepeating(
      [](TokenClient* self, std::string session, int value) {
        return self->ContextAllowed(session, value);
      },
      base::Unretained(this), session);
  context.session_known = base::BindRepeating(
      [](TokenClient* self, const std::string& value) {
        return self->targets_.contains(value);
      },
      base::Unretained(this));
  const std::string refusal = PluginRefusal(*scope_, method, params, context);
  if (refusal.empty()) {
    return true;
  }
  ++PluginTotalsSoFar().refused;
  *reply = ErrorReply(id, session, kMethodNotAllowed,
                      base::StrCat({"ardia: ", method, " ", refusal,
                                    " isn't allowed for a plugin"}));
  return false;
}

void TokenClient::SendInternal(const std::string& session,
                               const std::string& method,
                               base::DictValue params) {
  if (!to_browser_) {
    CloseOutOfScope();
    return;
  }
  int id = 0;
  do {
    id = std::numeric_limits<int>::min() + next_internal_id_++;
  } while (outstanding_.contains({session, id}));
  outstanding_[{session, id}] = kInternalCommand;
  base::DictValue command;
  command.Set("id", id);
  command.Set("method", method);
  command.Set("params", std::move(params));
  if (!session.empty()) {
    command.Set("sessionId", session);
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<TokenClient> self, std::string json) {
            if (self && self->to_browser_ && !self->revoked_) {
              self->to_browser_.Run(std::move(json));
            }
          },
          weak_factory_.GetWeakPtr(),
          base::WriteJson(command).value_or(std::string())));
}

void TokenClient::DetachOutOfScope(const std::string& session) {
  if (detaching_.contains(session) || !targets_.contains(session)) {
    return;
  }
  for (const std::string& gone : Subtree(session)) {
    for (const auto& [key, method] : outstanding_) {
      if (key.first == gone && method != kInternalCommand && to_client_) {
        to_client_.Run(OutOfScopeReply(key.second, gone));
      }
    }
  }
  auto parent = parents_.find(session);
  const std::string parent_session =
      parent == parents_.end() ? std::string() : parent->second;
  DropSubtree(session);
  detaching_.insert(session);
  SendInternal(parent_session, "Target.detachFromTarget",
               base::DictValue().Set("sessionId", session));
}

void TokenClient::CloseOutOfScope() {
  if (wedged_) {
    return;
  }
  for (const auto& [key, method] : outstanding_) {
    if (method != kInternalCommand && to_client_) {
      to_client_.Run(OutOfScopeReply(key.second, key.first));
    }
  }
  outstanding_.clear();
  wedged_ = true;
  if (closer_) {
    std::move(closer_).Run();
  }
}

void TokenClient::CheckScope() {
  if (!PluginCredentialLive(scope_->credential_id)) {
    Revoke();
    return;
  }
  if (!IsBrowserHost(root_host_.get()) &&
      !PluginTargetInScope(*scope_, root_host_.get())) {
    CloseOutOfScope();
    return;
  }
  std::vector<std::string> gone;
  for (const auto& [session, target] : targets_) {
    if (!detaching_.contains(session) &&
        !PluginMayAttachToTargetId(*scope_, &target)) {
      gone.push_back(session);
    }
  }
  for (const std::string& session : gone) {
    DetachOutOfScope(session);
  }
}

bool TokenClient::FilterPluginEvent(std::string_view method,
                                    std::string_view session_view,
                                    std::string& message) {
  const std::string session(session_view);
  if (!session.empty()) {
    if (detaching_.contains(session) || !targets_.contains(session)) {
      return false;
    }
    if (!SessionInScope(session)) {
      DetachOutOfScope(session);
      return false;
    }
  } else if (!IsBrowserHost(root_host_.get()) &&
             !PluginTargetInScope(*scope_, root_host_.get())) {
    CloseOutOfScope();
    return false;
  }
  if (method == "Target.attachedToTarget" ||
      method == "Target.detachedFromTarget") {
    return FilterTargetEvent(method, message);
  }
  if (method == "Target.targetInfoChanged" ||
      method == "Target.targetDestroyed") {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(message, base::JSON_PARSE_RFC);
    const base::DictValue* params =
        parsed && parsed->is_dict() ? parsed->GetDict().FindDict("params")
                                    : nullptr;
    const base::DictValue* info =
        params ? params->FindDict("targetInfo") : nullptr;
    const std::string* target_id =
        info ? info->FindString("targetId")
             : (params ? params->FindString("targetId") : nullptr);
    if (!target_id || !told_targets_.contains(*target_id)) {
      return false;
    }
    if (method == "Target.targetDestroyed") {
      told_targets_.erase(*target_id);
      return true;
    }
    return PluginMayAttachToTargetId(*scope_, target_id);
  }
  if (method == "Inspector.detached" || method == "Inspector.targetCrashed") {
    ForgetSessionOf(message);
    return true;
  }
  if (method.starts_with("Runtime.")) {
    return FilterPluginRuntimeEvent(method, message);
  }
  return PluginForwardsEvent(method);
}

bool TokenClient::FilterPluginRuntimeEvent(std::string_view method,
                                           const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return false;
  }
  const std::string* session_id = parsed->GetDict().FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  const base::DictValue* params = parsed->GetDict().FindDict("params");
  if (!params) {
    return false;
  }
  if (method == "Runtime.executionContextCreated") {
    const base::DictValue* context = params->FindDict("context");
    return context && ContextAllowed(session, context->FindInt("id"));
  }
  if (method == "Runtime.executionContextDestroyed") {
    const std::optional<int> context = params->FindInt("executionContextId");
    if (!ContextAllowed(session, context)) {
      return false;
    }
    contexts_[session].ids.erase(*context);
    return true;
  }
  if (method == "Runtime.executionContextsCleared") {
    contexts_.erase(session);
    return true;
  }
  if (method == "Runtime.exceptionThrown") {
    const base::DictValue* details = params->FindDict("exceptionDetails");
    return details &&
           ContextAllowed(session, details->FindInt("executionContextId"));
  }
  return false;
}

}
}

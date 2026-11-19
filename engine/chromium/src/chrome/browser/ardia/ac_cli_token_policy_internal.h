// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "content/public/browser/devtools_agent_host.h"

class GURL;

namespace content {
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace ardia {
namespace cli_token_policy_internal {

inline constexpr int kMethodNotAllowed = -32601;
inline constexpr int kInvalidRequest = -32600;
inline constexpr int kParseError = -32700;
inline constexpr int kRefused = -32000;
inline constexpr size_t kMaxPending = 4096;
inline constexpr char kAnswerFilePicker[] = "Ardia.answerFilePicker";

enum class CommandDomain {
  kTarget,
  kPage,
  kRuntime,
  kDom,
  kInput,
  kNetwork,
  kEmulation,
  kBrowser,
  kStorage,
  kFetch,
  kAccessibility,
  kOther,
  kCount,
};

CommandDomain DomainOf(std::string_view method);
void CountCommand(CommandDomain domain);

bool IsOffscreenTarget(const std::string* target_id);

bool IsWebUrl(const GURL& url);
bool IsWebDestination(std::string_view spec);
bool PluginTargetInScope(const PluginScope& scope,
                         content::DevToolsAgentHost* host);
bool PluginMayAttachToFrame(const PluginScope& scope,
                            content::RenderFrameHost* frame);
bool PluginMayAttachToTargetId(const PluginScope& scope,
                               const std::string* target_id);
std::string PluginRefusal(const PluginScope& scope,
                          const std::string& method,
                          const base::DictValue& params,
                          bool on_root_session);

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message);

class TokenClient;

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry();

class TokenClient : public ArdiaDevToolsTokenClient {
 public:
  TokenClient(content::DevToolsAgentHostClient* client,
              content::DevToolsAgentHost* host,
              TokenKind kind,
              std::optional<PluginScope> scope);
  ~TokenClient() override;

  TokenKind kind() const { return kind_; }
  const std::optional<PluginScope>& scope() const { return scope_; }
  content::DevToolsAgentHost* root_host() const { return root_host_.get(); }
  void Revoke();

  bool FilterCommand(std::string& message, std::string* reply) override;
  bool FilterEvent(std::string& message) override;
  bool ShouldClose() const override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool MayAttachToRenderFrameHost(content::RenderFrameHost* frame) override;
  bool MayReadLocalFiles() override;
  bool MayWriteLocalFiles() override;
  void SetCloser(base::OnceClosure close) override;

 private:
  bool AnswerFilePickerCommand(int id,
                               const std::string& session,
                               const base::DictValue* params,
                               std::string* reply);
  void ForgetSession(const std::string& session);
  void ForgetSessionOf(const std::string& message);
  void NoteCommand(const std::string& method,
                   const std::string& session,
                   const base::DictValue* params);
  bool FilterResponse(const std::string& method, std::string& message);
  bool FilterTargetEvent(std::string_view method, const std::string& message);

  const raw_ptr<content::DevToolsAgentHostClient> client_;
  const scoped_refptr<content::DevToolsAgentHost> root_host_;
  const TokenKind kind_;
  const std::optional<PluginScope> scope_;
  std::map<std::string, std::string> targets_;
  std::map<std::pair<std::string, int>, std::string> outstanding_;
  base::OnceClosure closer_;
  bool wedged_ = false;
};

}
}

#endif

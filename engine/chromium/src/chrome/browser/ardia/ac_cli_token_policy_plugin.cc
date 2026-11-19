// Copyright 2026 Ardia. Apache-2.0.

#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/child_process_security_policy.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/process_map.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

const std::set<std::string_view>& PluginMethods() {
  static const base::NoDestructor<std::set<std::string_view>> methods({
      "Accessibility.getFullAXTree",
      "DOM.describeNode",
      "DOM.enable",
      "DOM.focus",
      "DOM.getContentQuads",
      "DOM.getDocument",
      "DOM.getFrameOwner",
      "DOM.getNodeForLocation",
      "DOM.resolveNode",
      "DOM.scrollIntoViewIfNeeded",
      "Emulation.setFocusEmulationEnabled",
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
      "Page.captureScreenshot",
      "Page.createIsolatedWorld",
      "Page.enable",
      "Page.getFrameTree",
      "Page.getLayoutMetrics",
      "Page.handleJavaScriptDialog",
      "Page.navigate",
      "Page.reload",
      "Page.setLifecycleEventsEnabled",
      "Runtime.callFunctionOn",
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.getProperties",
      "Runtime.releaseObject",
      "Runtime.releaseObjectGroup",
      "Target.attachToTarget",
      "Target.detachFromTarget",
      "Target.getTargetInfo",
      "Target.getTargets",
      "Target.setAutoAttach",
  });
  return *methods;
}

const std::set<std::string_view>& PluginPageEvents() {
  static const base::NoDestructor<std::set<std::string_view>> events({
      "Page.documentOpened",
      "Page.domContentEventFired",
      "Page.frameAttached",
      "Page.frameDetached",
      "Page.frameNavigated",
      "Page.frameRequestedNavigation",
      "Page.frameStartedLoading",
      "Page.frameStartedNavigating",
      "Page.frameStoppedLoading",
      "Page.javascriptDialogClosed",
      "Page.javascriptDialogOpening",
      "Page.lifecycleEvent",
      "Page.loadEventFired",
      "Page.navigatedWithinDocument",
  });
  return *events;
}

bool ObjectIdsAllowed(const base::Value& value,
                      const PluginCommandContext& context) {
  if (const base::ListValue* list = value.GetIfList()) {
    for (const base::Value& item : *list) {
      if (!ObjectIdsAllowed(item, context)) {
        return false;
      }
    }
    return true;
  }
  const base::DictValue* dict = value.GetIfDict();
  if (!dict) {
    return true;
  }
  for (auto [key, item] : *dict) {
    if (key == "objectId" || key == "promiseObjectId" ||
        key == "prototypeObjectId") {
      const std::optional<int> object_context =
          item.is_string() ? ContextOfObjectId(item.GetString())
                           : std::nullopt;
      if (!object_context || !context.context_allowed.Run(*object_context)) {
        return false;
      }
      continue;
    }
    if (!ObjectIdsAllowed(item, context)) {
      return false;
    }
  }
  return true;
}

std::string TargetRefusal(const PluginScope& scope,
                          const std::string& method,
                          base::DictValue& params,
                          const PluginCommandContext& context) {
  if (method == "Target.getTargets") {
    return std::string();
  }
  if (method == "Target.setAutoAttach") {
    if (context.on_root_session) {
      return "on the browser session";
    }
    if (params.FindBool("autoAttach") != false &&
        params.FindBool("flatten") != true) {
      return "without flatten";
    }
    params.Set("waitForDebuggerOnStart", false);
    return std::string();
  }
  if (method == "Target.detachFromTarget") {
    if (const std::string* session = params.FindString("sessionId")) {
      return context.session_known.Run(*session) ? std::string()
                                                 : "on that session";
    }
  }
  if (method == "Target.attachToTarget" &&
      params.FindBool("flatten") != true) {
    return "without flatten";
  }
  if (method == "Target.getTargetInfo" && !params.Find("targetId") &&
      !context.on_root_session) {
    return std::string();
  }
  return PluginMayAttachToTargetId(scope, params.FindString("targetId"))
             ? std::string()
             : "on a target outside the plugin's window";
}

std::string RuntimeRefusal(const std::string& method,
                           const base::DictValue& params) {
  if (method == "Runtime.evaluate" && !params.Find("contextId")) {
    return "in the page's main world";
  }
  if (method == "Runtime.callFunctionOn" && !params.Find("objectId") &&
      !params.Find("executionContextId")) {
    return "in the page's main world";
  }
  if ((method == "Runtime.getProperties" || method == "Runtime.releaseObject") &&
      !params.Find("objectId")) {
    return "without an object";
  }
  return std::string();
}

bool IsWebProcess(content::RenderProcessHost* process) {
  if (!process) {
    return false;
  }
  if (content::ChildProcessSecurityPolicy::GetInstance()->HasWebUIBindings(
          process->GetID())) {
    return false;
  }
  extensions::ProcessMap* extension_processes =
      extensions::ProcessMap::Get(process->GetBrowserContext());
  return extension_processes && !extension_processes->Contains(process->GetID());
}

bool InScopeWindow(const PluginScope& scope, content::WebContents* contents) {
  if (!contents) {
    return false;
  }
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  Profile* profile = browser ? browser->GetProfile() : nullptr;
  return profile && browser->GetSessionID().id() == scope.window &&
         profile->GetPath() == scope.profile &&
         profile->IsOffTheRecord() == scope.off_the_record;
}

bool IsWebFrameInScope(const PluginScope& scope,
                       content::RenderFrameHost* frame) {
  if (!frame || !IsWebProcess(frame->GetProcess()) ||
      !InScopeWindow(scope, content::WebContents::FromRenderFrameHost(frame))) {
    return false;
  }
  const GURL& url = frame->GetLastCommittedURL();
  return url.is_empty() || IsWebUrl(url);
}

}

bool IsWebUrl(const GURL& url) {
  if (url.SchemeIsHTTPOrHTTPS() || url.SchemeIs(url::kDataScheme) ||
      url.IsAboutBlank() || url.IsAboutSrcdoc()) {
    return true;
  }
  if (url.SchemeIsBlob()) {
    const url::Origin origin = url::Origin::Create(url);
    return !origin.opaque() && (origin.scheme() == url::kHttpScheme ||
                                origin.scheme() == url::kHttpsScheme);
  }
  return false;
}

bool IsWebDestination(std::string_view spec) {
  const GURL url(spec);
  return url.is_valid() && IsWebUrl(url) && !url.IsAboutSrcdoc();
}

bool PluginTargetInScope(const PluginScope& scope,
                         content::DevToolsAgentHost* host) {
  if (!host) {
    return false;
  }
  const std::string type = host->GetType();
  if (type != content::DevToolsAgentHost::kTypePage &&
      type != content::DevToolsAgentHost::kTypeTab &&
      type != content::DevToolsAgentHost::kTypeFrame) {
    return false;
  }
  content::WebContents* contents = host->GetWebContents();
  if (!InScopeWindow(scope, contents) ||
      !IsWebProcess(host->GetProcessHost())) {
    return false;
  }
  const GURL url = host->GetURL();
  if (!url.is_empty() && !IsWebUrl(url)) {
    return false;
  }
  return type == content::DevToolsAgentHost::kTypeFrame ||
         IsWebFrameInScope(scope, contents->GetPrimaryMainFrame());
}

bool PluginMayAttachToFrame(const PluginScope& scope,
                            content::RenderFrameHost* frame) {
  return IsWebFrameInScope(scope, frame);
}

bool PluginMayAttachToTargetId(const PluginScope& scope,
                               const std::string* target_id) {
  return target_id &&
         PluginTargetInScope(
             scope, content::ArdiaDevToolsAgentHostForId(*target_id));
}

std::optional<int> ContextOfObjectId(std::string_view object_id) {
  std::vector<std::string_view> parts = base::SplitStringPiece(
      object_id, ".", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
  int64_t isolate = 0;
  int context = 0;
  int64_t serial = 0;
  if (parts.size() != 3 || !base::StringToInt64(parts[0], &isolate) ||
      !base::StringToInt(parts[1], &context) ||
      !base::StringToInt64(parts[2], &serial)) {
    return std::nullopt;
  }
  return context;
}

bool PluginForwardsEvent(std::string_view method) {
  return PluginPageEvents().contains(method) || method.starts_with("DOM.") ||
         method.starts_with("Accessibility.");
}

std::string PluginRefusal(const PluginScope& scope,
                          const std::string& method,
                          base::DictValue& params,
                          const PluginCommandContext& context) {
  if (!PluginMethods().contains(method)) {
    return "here";
  }
  if (params.Find("uniqueContextId")) {
    return "with uniqueContextId";
  }
  for (const char* key : {"contextId", "executionContextId"}) {
    if (const base::Value* value = params.Find(key)) {
      if (!value->is_int() || !context.context_allowed.Run(value->GetInt())) {
        return "outside the plugin's isolated world";
      }
    }
  }
  if (!ObjectIdsAllowed(base::Value(params.Clone()), context)) {
    return "on an object outside the plugin's isolated world";
  }
  const std::string_view domain =
      std::string_view(method).substr(0, method.find('.'));
  if (domain == "Target") {
    return TargetRefusal(scope, method, params, context);
  }
  if (domain == "Runtime") {
    return RuntimeRefusal(method, params);
  }
  if (method == "DOM.resolveNode" && !params.Find("executionContextId")) {
    return "in the page's main world";
  }
  if (method == "Page.createIsolatedWorld") {
    params.Set("grantUniveralAccess", false);
  }
  if (method == "Page.navigate") {
    const std::string* url = params.FindString("url");
    return url && IsWebDestination(*url) ? std::string() : "to that URL";
  }
  return std::string();
}

}

bool PluginMayConnectTo(const PluginScope& scope,
                        content::DevToolsAgentHost* host) {
  return (host && host->GetType() == content::DevToolsAgentHost::kTypeBrowser) ||
         cli_token_policy_internal::PluginTargetInScope(scope, host);
}

}

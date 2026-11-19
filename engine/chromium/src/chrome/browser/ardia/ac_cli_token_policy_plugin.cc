// Copyright 2026 Ardia. Apache-2.0.

#include <set>
#include <string>
#include <string_view>

#include "ardia/core/ac_content_hooks.h"
#include "base/no_destructor.h"
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

const std::set<std::string_view>& PluginDomains() {
  static const base::NoDestructor<std::set<std::string_view>> domains({
      "Accessibility", "CSS",     "DOM",     "DOMSnapshot", "Emulation",
      "Input",         "Log",     "Network", "Overlay",     "Page",
      "Performance",   "Runtime", "Target",
  });
  return *domains;
}

const std::set<std::string_view>& PluginRefusedMethods() {
  static const base::NoDestructor<std::set<std::string_view>> methods({
      "DOM.setFileInputFiles",
      "Network.clearBrowserCache",
      "Network.clearBrowserCookies",
      "Network.deleteCookies",
      "Network.getAllCookies",
      "Network.getCookies",
      "Network.loadNetworkResource",
      "Network.setCookie",
      "Network.setCookieControls",
      "Network.setCookies",
      "Page.setDownloadBehavior",
      "Page.setInterceptFileChooserDialog",
  });
  return *methods;
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

std::string PluginRefusal(const PluginScope& scope,
                          const std::string& method,
                          const base::DictValue& params,
                          bool on_root_session) {
  const std::string_view domain =
      std::string_view(method).substr(0, method.find('.'));
  if (!PluginDomains().contains(domain) ||
      PluginRefusedMethods().contains(method)) {
    return "here";
  }
  if (domain == "Target") {
    if (method == "Target.getTargets" || method == "Target.setDiscoverTargets" ||
        method == "Target.detachFromTarget") {
      return std::string();
    }
    if (method == "Target.setAutoAttach") {
      return params.FindBool("autoAttach") == false ||
                     params.FindBool("flatten") == true
                 ? std::string()
                 : "without flatten";
    }
    if (method != "Target.attachToTarget" &&
        method != "Target.getTargetInfo" &&
        method != "Target.activateTarget" && method != "Target.closeTarget") {
      return "here";
    }
    if (method == "Target.attachToTarget" &&
        params.FindBool("flatten") != true) {
      return "without flatten";
    }
    if (method == "Target.getTargetInfo" && !params.Find("targetId") &&
        !on_root_session) {
      return std::string();
    }
    return PluginMayAttachToTargetId(scope, params.FindString("targetId"))
               ? std::string()
               : "on a target outside the plugin's window";
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

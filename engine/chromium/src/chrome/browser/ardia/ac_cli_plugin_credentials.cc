// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/base64url.h"
#include "base/containers/span.h"
#include "base/no_destructor.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/web_contents.h"
#include "crypto/secure_util.h"

namespace ardia {
namespace {

constexpr size_t kSecretBytes = 32;

struct Credential {
  std::string secret;
  PluginScope scope;
};

std::map<std::string, Credential>& Credentials() {
  static base::NoDestructor<std::map<std::string, Credential>> credentials;
  return *credentials;
}

std::string RandomText(size_t bytes) {
  std::string text;
  base::Base64UrlEncode(base::RandBytesAsVector(bytes),
                        base::Base64UrlEncodePolicy::OMIT_PADDING, &text);
  return text;
}

}

MintedPluginCredential MintPluginCredential(PluginScope scope) {
  MintedPluginCredential minted;
  do {
    minted.id = "plugin-" + base::HexEncode(base::RandBytesAsVector(8));
  } while (Credentials().contains(minted.id));
  minted.secret = "p." + RandomText(kSecretBytes);
  scope.credential_id = minted.id;
  Credentials()[minted.id] = Credential{minted.secret, std::move(scope)};
  ++PluginTotalsSoFar().minted;
  return minted;
}

bool RevokePluginCredential(const std::string& id) {
  if (!Credentials().erase(id)) {
    return false;
  }
  ++PluginTotalsSoFar().revoked;
  CloseTokenClientsOf(id);
  return true;
}

std::optional<PluginScope> PluginScopeForSecret(std::string_view secret) {
  std::optional<PluginScope> found;
  for (const auto& [id, credential] : Credentials()) {
    if (credential.secret.size() == secret.size() &&
        crypto::SecureMemEqual(base::as_byte_span(credential.secret),
                               base::as_byte_span(secret))) {
      found = credential.scope;
    }
  }
  return found;
}

}

AC_ARGS_CALL(ac_cli_plugin_credential) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  if (const std::string* revoke = args.FindString("revoke")) {
    return out.Send(base::DictValue().Set(
        "revoked", ardia::RevokePluginCredential(*revoke)));
  }
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  BrowserWindowInterface* browser =
      contents
          ? GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents)
          : nullptr;
  Profile* profile = browser ? browser->GetProfile() : nullptr;
  if (!profile) {
    return out.Error("no such tab");
  }
  ardia::PluginScope scope;
  scope.window = browser->GetSessionID().id();
  scope.profile = profile->GetPath();
  scope.off_the_record = profile->IsOffTheRecord();
  const ardia::MintedPluginCredential minted =
      ardia::MintPluginCredential(std::move(scope));
  out.Send(base::DictValue()
               .Set("id", minted.id)
               .Set("credential", minted.secret)
               .Set("window", browser->GetSessionID().id())
               .Set("endpoint", ardia::TokenServerEndpoint()));
}

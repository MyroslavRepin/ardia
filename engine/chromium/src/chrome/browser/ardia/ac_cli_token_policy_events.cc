// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/json/json_reader.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_owned_tabs.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

std::string_view ReplySession(std::string_view view) {
  constexpr std::string_view kKey = R"(,"sessionId":")";
  if (view.size() < kKey.size() + 2 || !view.ends_with("\"}")) {
    return std::string_view();
  }
  const size_t end = view.size() - 2;
  const size_t open = view.rfind('"', end - 1);
  if (open == std::string_view::npos || open + 1 < kKey.size() ||
      view.substr(open + 1 - kKey.size(), kKey.size()) != kKey) {
    return std::string_view();
  }
  return view.substr(open + 1, end - open - 1);
}

std::optional<int> ParseResponseId(std::string_view view) {
  constexpr std::string_view kResponse = R"({"id":)";
  if (!view.starts_with(kResponse)) {
    return std::nullopt;
  }
  size_t end = kResponse.size();
  if (end < view.size() && view[end] == '-') {
    ++end;
  }
  while (end < view.size() && base::IsAsciiDigit(view[end])) {
    ++end;
  }
  int id = 0;
  if (end >= view.size() || (view[end] != ',' && view[end] != '}') ||
      !base::StringToInt(view.substr(kResponse.size(), end - kResponse.size()),
                         &id)) {
    return std::nullopt;
  }
  return id;
}

void ForgetDestroyedTarget(const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  const base::DictValue* params =
      parsed && parsed->is_dict() ? parsed->GetDict().FindDict("params")
                                  : nullptr;
  if (const std::string* target_id =
          params ? params->FindString("targetId") : nullptr) {
    ForgetCliOwnedTarget(*target_id);
  }
}

}

bool TokenClient::FilterEvent(std::string& message) {
  std::string_view view(message);
  constexpr std::string_view kEvent = R"({"method":")";
  if (view.starts_with(kEvent)) {
    size_t end = view.find('"', kEvent.size());
    if (end == std::string_view::npos) {
      return true;
    }
    std::string_view method = view.substr(kEvent.size(), end - kEvent.size());
    if (method == "Target.attachedToTarget" ||
        method == "Target.detachedFromTarget" ||
        (kind_ == TokenKind::kPlugin &&
         (method == "Target.targetCreated" ||
          method == "Target.targetInfoChanged"))) {
      return FilterTargetEvent(method, message);
    }
    if (method == "Target.targetDestroyed") {
      ForgetDestroyedTarget(message);
    } else if (method == "Inspector.targetCrashed" ||
               method == "Inspector.detached") {
      ForgetSessionOf(message);
    }
    return true;
  }
  if (outstanding_.empty()) {
    return true;
  }
  std::optional<int> id = ParseResponseId(view);
  std::string session;
  if (id) {
    session = std::string(ReplySession(view));
  } else {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(message, base::JSON_PARSE_RFC);
    if (!parsed || !parsed->is_dict()) {
      return true;
    }
    id = parsed->GetDict().FindInt("id");
    if (!id) {
      return true;
    }
    if (const std::string* found = parsed->GetDict().FindString("sessionId")) {
      session = *found;
    }
  }
  auto it = outstanding_.find({session, *id});
  if (it == outstanding_.end()) {
    return true;
  }
  const std::string method = std::move(it->second);
  outstanding_.erase(it);
  if (method.empty()) {
    return true;
  }
  return FilterResponse(method, message);
}

void TokenClient::ForgetSession(const std::string& session) {
  std::erase_if(outstanding_, [&](const auto& entry) {
    return entry.first.first == session;
  });
}

void TokenClient::ForgetSessionOf(const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return;
  }
  const std::string* session = parsed->GetDict().FindString("sessionId");
  ForgetSession(session ? *session : std::string());
}

bool TokenClient::FilterTargetEvent(std::string_view method,
                                    const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  const base::DictValue* params =
      parsed && parsed->is_dict() ? parsed->GetDict().FindDict("params")
                                  : nullptr;
  if (!params) {
    return kind_ == TokenKind::kCli;
  }
  const std::string* child = params->FindString("sessionId");
  if (method == "Target.detachedFromTarget") {
    if (child) {
      targets_.erase(*child);
      ForgetSession(*child);
    }
    return true;
  }
  const base::DictValue* info = params->FindDict("targetInfo");
  const std::string* target_id = info ? info->FindString("targetId") : nullptr;
  if (kind_ == TokenKind::kPlugin &&
      !PluginMayAttachToTargetId(*scope_, target_id)) {
    return false;
  }
  if (method == "Target.attachedToTarget" && child && target_id) {
    targets_[*child] = *target_id;
  }
  return true;
}

}
}

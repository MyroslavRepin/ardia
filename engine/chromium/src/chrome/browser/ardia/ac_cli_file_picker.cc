// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_file_picker.h"

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/shell_dialogs/select_file_dialog.h"

namespace ardia {
namespace {

constexpr base::TimeDelta kAnswerLifetime = base::Seconds(60);
constexpr base::TimeDelta kPromptLifetime = base::Seconds(30);

struct Answer {
  base::WeakPtr<content::WebContents> contents;
  FilePickerKind kind = FilePickerKind::kOpen;
  std::vector<base::FilePath> paths;
  const void* owner = nullptr;
  base::TimeTicks expires;
};

struct PromptGrant {
  base::WeakPtr<content::WebContents> contents;
  base::FilePath path;
  base::TimeTicks expires;
};

struct Totals {
  int armed = 0;
  int used = 0;
};

std::map<const content::WebContents*, Answer>& Answers() {
  static base::NoDestructor<std::map<const content::WebContents*, Answer>>
      answers;
  return *answers;
}

std::vector<PromptGrant>& PromptGrants() {
  static base::NoDestructor<std::vector<PromptGrant>> grants;
  return *grants;
}

Totals& TotalsSoFar() {
  static Totals totals;
  return totals;
}

std::optional<FilePickerKind> KindOfDialog(int dialog_type) {
  switch (static_cast<ui::SelectFileDialog::Type>(dialog_type)) {
    case ui::SelectFileDialog::SELECT_OPEN_FILE:
    case ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE:
      return FilePickerKind::kOpen;
    case ui::SelectFileDialog::SELECT_SAVEAS_FILE:
      return FilePickerKind::kSave;
    case ui::SelectFileDialog::SELECT_FOLDER:
    case ui::SelectFileDialog::SELECT_UPLOAD_FOLDER:
    case ui::SelectFileDialog::SELECT_EXISTING_FOLDER:
      return FilePickerKind::kDirectory;
    default:
      return std::nullopt;
  }
}

std::optional<FilePickerKind> KindNamed(const std::string* name) {
  if (!name) {
    return std::nullopt;
  }
  if (*name == "open") {
    return FilePickerKind::kOpen;
  }
  if (*name == "save") {
    return FilePickerKind::kSave;
  }
  if (*name == "directory") {
    return FilePickerKind::kDirectory;
  }
  return std::nullopt;
}

bool AnswerPicker(content::RenderFrameHost* frame,
                  int dialog_type,
                  std::vector<base::FilePath>* paths) {
  content::WebContents* contents =
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  auto it = contents ? Answers().find(contents) : Answers().end();
  if (it == Answers().end()) {
    return false;
  }
  if (!it->second.contents || base::TimeTicks::Now() > it->second.expires) {
    Answers().erase(it);
    return false;
  }
  const std::optional<FilePickerKind> kind = KindOfDialog(dialog_type);
  if (kind != it->second.kind) {
    return false;
  }
  Answer answer = std::move(it->second);
  Answers().erase(it);
  ++TotalsSoFar().used;
  const bool fits =
      answer.kind == FilePickerKind::kOpen
          ? (answer.paths.size() <= 1 ||
             dialog_type == ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE)
          : answer.paths.size() <= 1;
  if (!fits) {
    paths->clear();
    return true;
  }
  if (answer.kind == FilePickerKind::kDirectory && !answer.paths.empty()) {
    std::erase_if(PromptGrants(), [&](const PromptGrant& grant) {
      return !grant.contents || grant.contents.get() == contents;
    });
    PromptGrants().push_back(
        {contents->GetWeakPtr(), answer.paths.front(),
         base::TimeTicks::Now() + kPromptLifetime});
  }
  *paths = std::move(answer.paths);
  return true;
}

bool AnswerAccessPrompt(content::WebContents* contents,
                        const base::FilePath& path) {
  const base::TimeTicks now = base::TimeTicks::Now();
  for (auto it = PromptGrants().begin(); it != PromptGrants().end(); ++it) {
    if (it->contents.get() == contents && it->path == path &&
        now <= it->expires) {
      PromptGrants().erase(it);
      return true;
    }
  }
  return false;
}

}

std::string ArmFilePickerAnswer(content::WebContents* contents,
                                const base::DictValue& params,
                                const void* owner) {
  if (!contents) {
    return "on a target that isn't a tab";
  }
  const std::optional<FilePickerKind> kind =
      KindNamed(params.FindString("kind"));
  const base::ListValue* list = params.FindList("paths");
  if (!kind || !list) {
    return "without a kind (open, save or directory) and a paths list";
  }
  std::vector<base::FilePath> paths;
  for (const base::Value& item : *list) {
    const base::FilePath path =
        item.is_string() ? base::FilePath::FromUTF8Unsafe(item.GetString())
                         : base::FilePath();
    if (!path.IsAbsolute() || path.ReferencesParent()) {
      return "with a path that isn't absolute";
    }
    paths.push_back(path);
  }
  if (*kind != FilePickerKind::kOpen && paths.size() > 1) {
    return "with more than one path for that kind";
  }
  Answers()[contents] = Answer{contents->GetWeakPtr(), *kind, std::move(paths),
                               owner,
                               base::TimeTicks::Now() + kAnswerLifetime};
  ++TotalsSoFar().armed;
  return std::string();
}

void ForgetFilePickerAnswers(const void* owner) {
  std::erase_if(Answers(),
                [&](const auto& entry) { return entry.second.owner == owner; });
}

void InstallFilePickerAnswers() {
  g_ardia_file_picker_answer = &AnswerPicker;
  g_ardia_file_access_prompt_answer = &AnswerAccessPrompt;
}

base::DictValue FilePickerAnswerTotals() {
  return base::DictValue()
      .Set("armed", TotalsSoFar().armed)
      .Set("used", TotalsSoFar().used);
}

}

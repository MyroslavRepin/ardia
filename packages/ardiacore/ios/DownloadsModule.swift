import ExpoModulesCore

public class DownloadsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    OnCreate {
      ArdiaServices.watchDownloadEvents()
    }

    Self.calls.function
  }

  static func command(_ action: String) -> CallHandler {
    { args, reply in
      let id = try args.text("id")
      PageEngines.owner(of: id).downloadCommand(action, id: id)
      reply.ok()
    }
  }

  static let rename: CallHandler = { args, reply in
    let id = try args.text("id")
    let name = try args.text("name")
    guard !WebKitPageEngine().owns(id) else { return reply.fail("ERR_UNSUPPORTED", "WebKit downloads can't be renamed") }
    ArdiaServices.renameDownload(id, name: name) { value, error in reply.service(value, error) }
  }

  static let suggestName: CallHandler = { args, reply in
    let path = try args.text("path")
    let filename = try args.text("filename")
    DownloadNamer.suggest(path: path, filename: filename) { reply.ok($0) }
  }

  static let calls = CallTable(domain: "downloads", handlers: [
    "cancel": command("cancel"),
    "pause": command("pause"),
    "resume": command("resume"),
    "keep": command("keep"),
    "rename": rename,
    "suggestName": suggestName,
    "namerStatus": { _, reply in reply.ok(DownloadNamer.status()) },
    "settings": EngineCall.passing("ac_downloads_settings"),
    "setSettings": EngineCall.passing("ac_downloads_set_settings"),
  ])
}

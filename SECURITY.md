# Security

[简体中文](SECURITY.zh.md) | English

This plugin runs an HTTP route on the DSH Web server and gives an agent Session
access to a workspace. Treat it accordingly.

- Keep the DSH Web server on loopback unless you have your own network controls.
  The custom `x-super-chat-request` header and `Origin` check are CSRF defences,
  not authentication.
- Chat data lives in `stateDir` as `chat.sqlite` (plus WAL/SHM files) with owner-only
  permissions. This plugin does not upload it, but messages are sent to the model
  provider configured in the DSH profile, like any other Session.
- Choose `cwd` and `permissionPreset` deliberately. The panel has no approval UI,
  so an asking approval preset can leave a turn waiting; see the README.
- Do not commit `stateDir`, `chat.sqlite`, model credentials, or chat exports to a
  repository. The default `stateDir` lives outside the plugin checkout.

To report a vulnerability, use the repository's private security advisory form
rather than a public issue. Include the plugin version, DSH version, and a minimal
reproduction without real credentials or private chat content.

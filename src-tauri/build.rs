fn main() {
    // ★ 以管理员身份运行：注入 / 卸载 / 设置安全模式都要写 Program Files
    //   和调用 bcdedit，与其每个操作各弹一次 UAC，不如启动时提权一次。
    #[cfg(windows)]
    {
        let attrs = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(
                r#"<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
</assembly>"#,
            ),
        );
        tauri_build::try_build(attrs).expect("tauri-build failed");
    }
    #[cfg(not(windows))]
    {
        tauri_build::build();
    }
}

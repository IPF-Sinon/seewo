fn main() {
    // ★ 以管理员身份运行：注入 / 卸载 / 设置安全模式都要写 Program Files
    //   和调用 bcdedit，与其每个操作各弹一次 UAC，不如启动时提权一次。
    //
    // ★★ 这里必须保留 Common Controls v6 依赖！
    //    上一版只写了 requestedExecutionLevel，把 Tauri 默认清单里的
    //    Microsoft.Windows.Common-Controls v6 依赖弄丢了，
    //    结果进程加载的是旧版 comctl32.dll —— 它没有 TaskDialogIndirect 导出，
    //    启动直接报「无法定位程序输入点 TaskDialogIndirect」。
    #[cfg(windows)]
    {
        let attrs = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(
                r#"<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}" />
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}" />
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">permonitorv2,permonitor</dpiAwareness>
    </windowsSettings>
  </application>
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

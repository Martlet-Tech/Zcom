use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // 本机调试环境说明（见 .cargo/config.toml + test_runner.bat）：
    // tauri-plugin-dialog (rfd) 静态导入 comctl32!TaskDialogIndirect，该函数
    // 仅 comctl32 v6 导出；System32 为 v5.82，无 manifest 的进程（cargo test
    // harness）加载即 0xC0000139。cargo test 通过 runner 在运行前用 mt.exe
    // 嵌入 comctl32 v6 依赖声明，bin/cdylib 不受影响。
    //
    // 注意：勿用 cargo::rustc-link-arg 嵌入 manifest —— bin 的 tauri .rc
    // 资源已有 RT_MANIFEST，会触发 CVT1100 重复资源（LNK1123）。
    let _ = PathBuf::new();
}

<p align="center">
  <img src="src-tauri/icons/app-icon.png" width="128" height="128" alt="ZCOM">
</p>

<h1 align="center">ZCOM</h1>

<p align="center">
  高性能串口调试助手 — Rust + Tauri
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-1.96-orange" alt="Rust">
  <img src="https://img.shields.io/badge/Tauri-2.11-blue" alt="Tauri">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="Platform">
</p>

---

## 特性

- **串口通信** — 自动枚举 COM 口，显示设备名称，支持 USB 串口热插拔
- **双模收发** — 文本/Hex 发送与接收，实时切换
- **多字符串发送** — 独立窗口，条目拖拽排序，独立 Hex/延迟控制，循环发送，JSON 导入导出
- **编码支持** — UTF-8 / GBK 可选，解决中文乱码问题
- **校验码** — CRC16-Modbus / CRC32 / ADD8 / XOR8，支持自定义插入位置
- **文件发送** — 选择文件分块发送，支持中止
- **接收保存** — 接收区数据保存到文件
- **自动滚屏** — 数据滚动时自动暂停，滚动到底自动继续
- **时间戳** — 收发双向时间戳标记
- **置顶窗口** — 主窗口和多字符串窗口均支持置顶
- **主题切换** — 深色/浅色/系统/高对比
- **界面设置** — 字号、字体、颜色自定义
- **配置持久化** — 所有设置自动保存

## 快速开始

```bash
# 依赖
npm install

# 开发模式
npm run tauri dev

# 生产构建
npm run tauri build
```

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri v2 |
| 后端 | Rust — serialport / encoding_rs / crc |
| 前端 | 原生 HTML / CSS / JS |
| 构建 | Vite + @tauri-apps/cli |

## 下载

访问 [Releases](https://github.com/Martlet-Tech/Zcom/releases) 页面下载最新版本。

## License

MIT

# Translate for Zotero — 医学翻译版

[![zotero target version](https://img.shields.io/badge/Zotero-7%2F8%2F9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL%203.0-orange?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0.html)

本插件是 [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) 的医学翻译定制版,在保留原版全部功能(PDF/EPub/网页翻译、标题/摘要翻译、注释翻译、独立翻译窗口等)的基础上,针对医学文献做了深度定制。

## 与上游版本的区别

| 特性 | 说明 |
|---|---|
| 🏥 医学专用翻译服务 `medical-translator` | 内置医学词库:3176 条医学缩写 + 913 条通用医学术语,翻译时自动匹配原文及论文上下文中出现的术语,注入提示词辅助模型统一译名 |
| 🔑 DeepSeek 大模型驱动 | 支持流式输出、自定义 API 地址和模型名,默认 `deepseek-flash` |
| 📖 自定义术语表 | 在插件设置里填写你自己的术语对照表,优先级高于系统词库 |
| 📝 纯译文输出 | 只输出译文本身,不带任何标注、括号解释或术语注释 |
| ⚡ 性能优化 | 上下文只取标题+摘要(1000 字符)、术语注入上限收紧、翻译缓存、批量翻译 3 并发 |
| 🔄 自动更新 | 已配置 update.json,新版发布后 Zotero 会自动提示更新 |

## 安装

1. 从 [Releases](https://github.com/nian1147/zotero-pdf-translate-medical/releases) 下载最新的 `translate-for-zotero.xpi`
2. 打开 Zotero → `工具` → `插件` → 右上角齿轮 → `从文件安装插件`
3. 选择下载的 `.xpi` 文件,重启 Zotero 完成安装

## 配置(三步)

**第 1 步:获取 DeepSeek API Key**

访问 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key(形如 `sk-...`)。

**第 2 步:切换翻译服务**

Zotero → `编辑` → `设置` → `Translate` → `通用` 页,把翻译引擎切换为 `medical-translator`。

**第 3 步:填入 Key 并确认模型**

在设置里填入你的 API Key。模型默认 `deepseek-flash`(快速模型),也可按需改成其他 DeepSeek 模型;API 地址默认官方接口,使用中转/代理时按需修改。

### 自定义术语表(可选)

在 `medical-translator` 服务的设置里可以填写自定义术语对照表,一行一条,优先级最高:

```
# 以 # 开头的行为注释
MACE → 主要心血管不良事件
PCI → 经皮冠状动脉介入治疗
```

## 使用

- 在 Zotero 阅读器中选中文字,弹窗和右侧条目窗格会显示翻译
- 选中文字后按 `Ctrl+T`(Windows/Linux)翻译条目标题;右键菜单可翻译摘要
- 高亮/下划线标注的文字可自动翻译到注释中
- 独立翻译窗口可同时对比多个服务的翻译结果
- 整篇 PDF 批量翻译:选中多段文字后批量翻译,3 个任务并发执行

## 更新

安装过 v2.5.6 及以上版本后,Zotero 会自动检测并提示更新;更早的版本请手动从 [Releases](https://github.com/nian1147/zotero-pdf-translate-medical/releases) 重新下载安装一次。

## 开发

```bash
npm install
npm run build
```

构建产物在 `./build/*.xpi`。

## 致谢与许可

本项目基于 [windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) 二次开发,遵循 AGPL-3.0 协议,保留上游版权。使用本插件请自行承担相关风险,并遵守当地法律法规。

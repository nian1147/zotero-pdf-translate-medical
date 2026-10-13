# Translate for Zotero — 医学翻译版

[![zotero target version](https://img.shields.io/badge/Zotero-7%2F8%2F9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL%203.0-orange?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0.html)

本插件是 [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) 的医学翻译定制版,支持 PDF/EPub/网页翻译、标题/摘要翻译、注释翻译和独立翻译窗口,并针对医学文献做了深度定制。翻译服务仅保留 AI 模型接口。

## 与上游版本的区别

| 特性 | 说明 |
|---|---|
| 🏥 医学专用翻译服务 `medical-translator` | 内置医学词库:3176 条医学缩写 + 913 条通用医学术语,翻译时自动匹配原文及论文上下文中出现的术语,注入提示词辅助模型统一译名 |
| 🔑 DeepSeek 大模型驱动 | 支持流式输出、自定义 API 地址和模型名,默认 `deepseek-flash` |
| 📖 自定义术语表 | 在插件设置里填写你自己的术语对照表,优先级高于系统词库 |
| 📝 纯译文输出 | 只输出译文本身,不额外添加术语注释;原文已有的括号、数字和解释完整保留 |
| ⚡ 性能优化 | 上下文只取标题+摘要(1000 字符)、术语注入上限收紧、翻译缓存、批量翻译 3 并发 |
| 🔄 自动更新 | 已配置 update.json,新版发布后 Zotero 会自动提示更新 |
| 🤖 仅 AI 模型接口 | 医学翻译 (DeepSeek)、OpenAI、Azure OpenAI、Claude、Gemini、Qwen-MT、有道大模型和三个自定义 OpenAI 兼容接口 |
| 🐥 自定义头像 | 设置页、插件管理、阅读器翻译栏和菜单统一使用小鸡头像 |

## 安装

1. 从 [Releases](https://github.com/nian1147/zotero-pdf-translate-medical/releases) 下载最新的 `translate-for-zotero.xpi`
2. 打开 Zotero → `工具` → `插件` → 右上角齿轮 → `从文件安装插件`
3. 选择下载的 `.xpi` 文件,重启 Zotero 完成安装

## 配置(三步)

**第 1 步:获取 DeepSeek API Key**

访问 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key(形如 `sk-...`)。

**第 2 步:切换翻译服务**

Zotero → `编辑` → `设置` → `Translate` → `通用` 页,选择“医学翻译 (DeepSeek)” (`medical-translator`)。新安装或升级时原服务已被移除,会默认选择这一服务;已有 AI 服务选择及其密钥、模型和接口配置会保留。

**第 3 步:填入 Key 并确认模型**

在设置里填入你的 API Key。模型默认 `deepseek-flash`(快速模型),也可按需改成其他 DeepSeek 模型;API 地址默认官方接口,使用中转/代理时按需修改。

### 其他 AI 模型

可选择 OpenAI、Azure OpenAI、Claude、Gemini、Qwen-MT 或有道大模型,填写对应服务的密钥并点击“配置”。其他提供 OpenAI 兼容 API 的模型,包括中转服务和本地模型,可使用“自定义 AI 1/2/3”,设置完整接口地址和模型名。单词与句子均由当前选中的 AI 服务翻译。

必应、CNKI、Google 翻译、DeepL、传统云翻译及词典服务不再提供;与词典关联的播放发音设置一并移除。选择 AI 接口意味着翻译需要相应接口配置,使用云 API 时可能产生费用。

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

### v2.5.9

- 服务注册表仅保留上述 10 个 AI 接口,设置页、阅读器、独立窗口、密钥管理和插件 API 使用相同列表;传统翻译和词典适配器不再打包。
- 移除词典服务和播放发音设置,单词直接使用选中的 AI 模型,避免调用已移除的词典。
- 无效或已移除的旧服务回退到医学翻译;清理多引擎列表中的已移除服务,保留已有 AI 密钥、模型、接口、自定义术语和语言设置。
- 设置页、插件管理、菜单及阅读器翻译栏改用自定义小鸡头像。

### v2.5.8

- 相同文本、语言、接口和配置的同时请求合并为一次 API 调用,流式界面刷新按 50 ms 节流。
- 缓存包含接口地址、语言、模型、温度、自定义术语和当前论文标题、摘要;缓存命中不请求接口、不重复写入配置。
- 缩写匹配保留大小写,避免将普通词 `or`、`as` 解释成医学缩写;词库匹配完整词,优先选择当前原文中的术语。
- 自定义术语仅注入当前原文实际出现的条目,支持箭头、冒号、等号及制表符分隔,保留术语里的连字符和逗号。
- 提示词强调保留剂量、单位、统计值、否定、条件和不确定性,并遵循设置中的源语言和目标语言。歧义缩写以原文定义及语境为准。
- 医学翻译和 Gemini 修复网络分片解析及响应末尾遗漏;接口错误、空结果和截断输出会显示失败,不会存入成功缓存。Gemini 不显示模型思考内容或拼接备选译文。
- 为请求保留 120 秒超时,避免连接永久等待;自动发布构建增加回归测试。

本版未更改默认模型。改进主要针对重复请求、术语匹配和响应完整性,实际翻译耗时和译文质量仍取决于所选模型及网络。

安装过 v2.5.6 及以上版本后,Zotero 会自动检测并提示更新;更早的版本请手动从 [Releases](https://github.com/nian1147/zotero-pdf-translate-medical/releases) 重新下载安装一次。

## 开发

```bash
npm install
npm test
npm run build
```

构建产物在 `./build/*.xpi`。

## 致谢与许可

本项目基于 [windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) 二次开发,遵循 AGPL-3.0 协议,保留上游版权。使用本插件请自行承担相关风险,并遵守当地法律法规。

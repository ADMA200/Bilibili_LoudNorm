# 第三方资源与致谢

本项目的**全部源码为自有实现**（未使用任何第三方脚本的代码，详见 `docs/B站响度归一-方案与实测.md`
的溯源核查一节）。以下为使用到的第三方**资源、标准与设计参考**，在此致谢并声明其许可。

## 图标（Apache-2.0）

| 资源 | 出处 | 许可 |
|---|---|---|
| 齿轮图标 | [Material Design Icons](https://materialdesignicons.com/)（Pictogrammers）`mdi-cog` | Apache-2.0 |
| 均衡器图标 | [Google Material Icons](https://fonts.google.com/icons) `equalizer`（MDI 体系的写法来源） | Apache-2.0 |

两者的 SVG path 数据以**逐字符一致**的形式内联在 `src/panel.js` 中。
Apache-2.0 第 4 条要求保留署名 —— 本文件即满足该要求（上游未随图标附 NOTICE 文件）。

## 设计令牌参考（MIT）

| 参考 | 说明 |
|---|---|
| [Bilibili Evolved](https://github.com/the1812/Bilibili-Evolved) | 侧边面板的**尺寸令牌**（26px 内容 + 8px padding + `content-box` → 外径 42px、按钮间距 26px、`::after` 140%/-20% 热区外扩）参照其公开样式 `.be-settings > .sidebar > *` 设定。**仅借鉴设计参数，未复制其代码**（该项目为 Vue 3 + TypeScript 工程，与本项目语言栈完全不同）。源码注释中已逐条标注〔对齐 Evolved〕。 |

## 算法与标准

| 来源 | 用途 |
|---|---|
| **ITU-R BS.1770-4** / **EBU R128** | 集成响度（LUFS）与真峰值（dBTP）的测量标准 —— 公开标准，非代码引用 |
| [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) | K 加权双二阶滤波器的**系数推导方法**参考（MIT） |

## 灵感来源（非代码来源）

本项目定位为 [greasyfork 587251《B站无损音量平衡》](https://greasyfork.org/scripts/587251)
的替代实现：保留其「整片一个固定增益、播放零干扰」的产品理念，实现方式完全重写。
**未使用其任何代码**（该脚本为 MPL-2.0，本仓库不包含其源码，也不构成其衍生作品）。

---

> 若你是在本项目中发现了遗漏的第三方资源，欢迎提 issue 补充。

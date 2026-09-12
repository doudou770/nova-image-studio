# FlyReq Image Studio

<p align="right"><strong>简体中文</strong> | <a href="./README.en.md">English</a></p>

<div align="center">

**自托管的 AI 生图工作台 · 视频工作台 · 多模型协议 · 无限画布 · 素材库 · PWA**

[![Version](https://img.shields.io/badge/version-v1.5.1-blue.svg)](https://github.com/doudou770/flyreq-image-studio)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev)

</div>

---

## 📖 简介

FlyReq Image Studio（简称 FlyReq Image）是一个面向个人与团队的 AI 图片和视频创作工作台。前端使用 Next.js 16 + React 19 静态导出（PWA），后端是轻量 Node.js 服务（`server.js` + SQLite + WebSocket），统一调度任务并代理图片与视频生成 API。

**核心亮点：**

- **多模型接入**：图片、视频、文本模型独立配置，兼容 Google、OpenAI、xAI 和 New API
- **能力自适应**：按模型能力显示分辨率、参考素材、时长、画幅和高级参数
- **图像视频一体化**：支持文生图、图生图、GIF、视频生成和无限画布创作
- **生产部署友好**：支持环境变量配置品牌、默认模型、并发和限流，不覆盖已有用户配置
- **外链快速配置**：通过 URL 预填图片、视频或文本模型，确认后再保存
- **任务稳定可追踪**：队列持久化、WebSocket 实时同步、断线轮询、失败诊断和本地备份一应俱全





## 🖼️ UI 预览

### 生图工作台

| 宽屏 |  手机版 |
|:---:|:---:|
| ![生图工作台宽屏](doc/生图工作台宽屏.png) | ![生图工作台手机版](doc/生图工作台手机版.png) |

### 视频工作台

| 宽屏 | 手机版 |
|:---:|:---:|
| ![生图工作台宽屏](doc/视频工作台宽屏.png) | ![视频工作台手机版](doc/视频工作台手机版.png) |

### Agent 模式

| 询问 | 生成 |
|:---:|:---:|
| ![Agent模式询问](doc/Agent模式询问.png) | ![Agent模式生成](doc/Agent模式生成.png) |

### GIF 生成

| 生成 | 微调 |
|:---:|:---:|
| ![GIF生成](doc/GIF生成.png) | ![GIF微调](doc/GIF微调.png) |

### 无限画布

![无限画布编辑](doc/无限画布编辑.png)

### 提示词优化

| 入口按钮 | 优化结果 |
|:---:|:---:|
| ![提示词优化按钮](doc/提示词优化按钮.png) | ![提示词优化结果](doc/提示词优化结果.png) |

### 灵感与素材

| 提示词广场 | 我的素材 |
|:---:|:---:|
| ![提示词广场](doc/提示词广场.png) | ![我的素材](doc/我的素材.png) |

### 配置与创作

| 反推提示词 | 设置 |
|:---:|:---:|
| ![反推提示词](doc/反推提示词.png) | ![设置](doc/设置.png) |

---
## 💎 赞助商

<table>
  <tr>
    <td width="180" align="center">
      <a href="https://flyreq.com">
        <img src="frontend/public/icon-512.png" width="112" alt="FlyReq" />
      </a>
    </td>
    <td>
      <strong>感谢 <a href="https://flyreq.com">FlyReq</a> 对本项目的赞助支持！</strong><br /><br />
      FlyReq 是一家提供高折扣 AI 模型 API 中转服务的平台，帮助个人开发者和团队以更具成本优势的方式接入所需模型服务。<br /><br />
      新用户注册即可获得体验额度，用于验证模型能力和接入流程。访问 <a href="https://flyreq.com">flyreq.com</a> 了解服务详情并开始体验。
    </td>
  </tr>
</table>

---



## 🧩 支持的图片与视频模型

| 类型 | 厂商/协议 | 模型 ID / 说明 |
| :--- | :--- | :--- |
| **图片** | Banana 系列 | `gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`... |
| **图片** | GPT 系列 | `gpt-image-2`、`gpt-image-1.5`、`gpt-image-1`... |
| **图片** | Grok 系列 | `grok-imagine-image`、`grok-imagine-image-quality` ...|
| **图片** | 自定义 | 支持自定义模型 ID |
| **视频** | New API | 通用视频协议，支持自定义模型 ID |
| **视频** | OpenAI Videos (Sora) | `seedance-2.0-431-720p`、`seedance-2.0-1080p` ...|
| **视频** | xAI Videos | `grok-imagine-video`、`grok-imagine-video-1.5` ...|

---

## ✨ 功能特性

### 五大工作模式

| 模式 | 入口 | 简介 |
| --- | --- | --- |
| 🎨 文本生图 | `TextToImageForm` | 纯文字提示词生成图像，支持多图并行 |
| 🖼️ 图生图 | `ImageToImageForm` | 上传参考图，编辑/转换/风格化 |
| 🤖 Agent 智能体 | `AgentChatWorkspace` | 多轮对话式生成：聊天 → 方案 → 出图，支持 vision 描述、联网搜索、reasoning |
| 🔍 反推提示词 | `ReversePromptForm` | 上传图片流式反推提示词（支持所有已配置的文字模型） |
| 🎬 动图生成 | `GifGenerationWorkspace` | 多帧生图 + 网格拼合，浏览器端编码 GIF（`gifenc`） |


## 🚀 部署指南

<details>
<summary><strong>🐳 Docker Compose 部署</strong></summary>

### 前置要求

- Docker 20.10+
- Docker Compose v2

### 快速启动

默认安装目录为 `/opt/fis`。下面命令会直接从 [doudou770/flyreq-image-studio](https://github.com/doudou770/flyreq-image-studio) 下载部署所需的 4 个文件：

- `docker-compose.yml`：Docker Compose 服务定义
- `.env`：后端运行配置
- `prompts.json`：提示词广场数据
- `blacklist.json`：敏感词配置

```bash
# 1. 创建并进入部署目录
sudo mkdir -p /opt/fis
cd /opt/fis

# 2. 下载 Docker Compose 配置
sudo curl -fsSL \
  https://raw.githubusercontent.com/doudou770/flyreq-image-studio/master/docker-compose.yml \
  -o docker-compose.yml

# 3. 下载环境变量模板为 .env
sudo curl -fsSL \
  https://raw.githubusercontent.com/doudou770/flyreq-image-studio/master/backend/.env.example \
  -o .env

# 4. 下载提示词与敏感词配置
sudo curl -fsSL \
  https://raw.githubusercontent.com/doudou770/flyreq-image-studio/master/backend/prompts.json \
  -o prompts.json
sudo curl -fsSL \
  https://raw.githubusercontent.com/doudou770/flyreq-image-studio/master/backend/blacklist.json \
  -o blacklist.json

# 5. 创建持久化数据目录
sudo mkdir -p data

# 6. 按需编辑配置（可选）
sudo nano .env

# 7. 启动服务
sudo docker compose up -d
```

访问 <http://localhost:3001>。

`docker-compose.yml` 默认使用：

```yaml
image: ghcr.io/doudou770/flyreq-image-studio:latest
```

如果 GitHub Packages 中的镜像包被设置为私有，需要先登录 GHCR：

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

### 文件布局

部署完成后，`/opt/fis` 目录结构如下：

```text
/opt/fis/
├── docker-compose.yml
├── .env
├── prompts.json
├── blacklist.json
└── data/
```

`docker-compose.yml` 已内置持久化路径：

```yaml
FLYREQ_TASK_DB: /app/backend/data/flyreq-tasks.sqlite
FLYREQ_IMAGE_DIR: /app/backend/data/flyreq-images
```

因此任务数据库和生成图片都会落在宿主机 `/opt/fis/data/` 下。

`docker-compose.yml` 默认加入 1Panel 常用外部网络 `1panel-network`，便于直接通过 Docker 内网访问同一网络中的 new-api 等服务。若你的 1Panel 网络名称不同，请修改 `docker-compose.yml` 里的 `networks` 名称；若不是 1Panel 环境，可删除 `networks` 配置或先创建同名网络：

```bash
sudo docker network create 1panel-network
```

### 环境变量

通过 `/opt/fis/.env` 注入，无需修改镜像。

`PORT`、`HOSTNAME`、`NODE_ENV` 这类启动参数修改后需要重启容器：

```bash
cd /opt/fis
sudo docker compose restart
```

队列、限流、提示词广场等运行时配置会被后端定期读取，保存 `.env` 后通常无需重启即可生效。

如果用户模型中填写的是公开 Base URL，但希望服务端实际请求走 Docker 内网地址，可以配置 `FLYREQ_BASE_URL_REWRITE_MAP`。例如用户仍填写 `https://flyreq.com`，后端实际请求同一 1Panel 网络里的 new-api 容器：

```env
FLYREQ_BASE_URL_REWRITE_MAP={"https://flyreq.com":"http://new-api:3000"}
```

支持多个映射：

```env
FLYREQ_BASE_URL_REWRITE_MAP={"https://flyreq.com":"http://new-api:3000","https://api.example.com":"http://example-new-api:3000"}
```

匹配会自动忽略末尾 `/v1` 或 `/v1beta`：用户填 `https://flyreq.com/v1` 也会命中 `https://flyreq.com`。映射只影响后端出站请求，不会改写用户保存的模型配置。

### 升级

拉取最新镜像并重建容器：

```bash
cd /opt/fis
sudo docker compose pull
sudo docker compose up -d --force-recreate
```

### 数据持久化

以下内容自动持久化在 `/opt/fis/data/`：

- `flyreq-images/`：生成的图片
- `flyreq-tasks.sqlite`：任务数据库
- `flyreq-tasks.sqlite-wal` / `flyreq-tasks.sqlite-shm`：SQLite 运行文件

备份时建议直接备份整个 `/opt/fis` 目录。

</details>

<details>
<summary><strong>📦 本地部署（生产环境）</strong></summary>

### 环境要求

- **Node.js**：20 或 22
- **npm**：自带 workspaces 支持
- `better-sqlite3` 是原生依赖，**生产服务器必须本地 `npm ci --omit=dev`**，不要直接复制本机 `node_modules`

### 部署步骤

#### 1. 在构建机

```bash
npm ci
npm run build
```

产物 `frontend/out/` 已生成。

#### 2. 上传以下到生产服务器

```text
frontend/out/
backend/server.js
backend/package.json
backend/package-lock.json
backend/prompts.json
backend/blacklist.json
backend/.env          # 按生产环境调整
```

#### 3. 在生产服务器

```bash
npm ci --omit=dev        # 必须本地装 better-sqlite3 原生模块
npm start                # 或 npm run server
```

`.env` 中 `NODE_ENV=production`。

#### 4. 进程托管

推荐 **PM2 / systemd / 平台自带进程管理**，确保：

- 进程对 `FLYREQ_TASK_DB` 指向的 SQLite 文件有读写权限
- 反向代理（Nginx / Caddy / 云网关）将域名转到 `http://127.0.0.1:3001`

#### 5. 一键打包

```bash
npm run go
```

生成根目录 `out.zip`，解压后即可按上面 1~3 步骤部署。

</details>

<details>
<summary><strong>💻 本地开发</strong></summary>

### 环境要求

- **Node.js**：20 或 22
- **npm**：自带 workspaces 支持

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/doudou770/flyreq-image-studio.git
cd flyreq-image-studio

# 2. 安装依赖（自动安装根、frontend、backend）
npm install

# 3. 复制后端环境变量
cp backend/.env.example backend/.env
# Windows: Copy-Item backend/.env.example backend/.env

# 4. 启动开发模式（等同于 build 后用 production 模式跑 server.js）
npm run dev
```

访问 <http://localhost:3001>。

> 首次启动时，图片模型会使用部署者配置的默认模型（未配置时使用 FlyReq / GPT Image 2 预设）；出于安全原因不会下发 API Key。请在 UI 的“设置”中填写图片模型 API Key，并至少配置一个文本模型及其 API Key，再确认各任务的默认模型。所有前端配置均保存在浏览器 localStorage，可通过备份功能导出。

### 常用开发脚本

```bash
npm run dev:frontend   # 仅启动 Next.js dev server（HMR，不走静态导出）
npm run dev:backend    # 仅启动后端 server.js
npm run build          # 构建前端静态产物到 frontend/out/
npm start              # 直接跑后端 server.js
npm run lint           # 前端 ESLint
npm test               # 前端 Vitest watch
npm run test:run       # 前端 Vitest 单次
npm run go             # 打包：build + 汇总到根 out.zip
```

</details>

<details>
<summary><strong>🔨 Docker 镜像构建</strong></summary>

### 构建镜像

```bash
docker build -t flyreq-image-studio:latest .
```

### 推送到仓库

```bash
docker tag flyreq-image-studio:latest ghcr.io/doudou770/flyreq-image-studio:latest

docker push ghcr.io/doudou770/flyreq-image-studio:latest
```

</details>

<details>
<summary><strong>🚢 GitHub Actions 发布</strong></summary>

仓库内置手动发布工作流：`.github/workflows/release.yml`。

在 GitHub 页面进入 **Actions → Release → Run workflow**，选择 `patch` / `minor` / `major` 后运行即可。工作流会固定检出 `master` 分支，并自动完成：

- 读取最新 `vX.Y.Z` tag，按选择的类型自增版本号
- 创建并推送新的 git tag，例如 `v1.5.1`
- 创建 GitHub Release，并自动生成 release notes
- 将 tag 版本写入 Docker 镜像的 `APP_VERSION`，自动展示在 UI 的“关于”页
- 构建 Docker 镜像并推送到 GitHub Packages：
  - `ghcr.io/doudou770/flyreq-image-studio:latest`
  - `ghcr.io/doudou770/flyreq-image-studio:X.Y.Z`
  - `ghcr.io/doudou770/flyreq-image-studio:vX.Y.Z`

工作流使用仓库内置的 `GITHUB_TOKEN`，需要在仓库设置中允许 Actions 写入 `contents` 和 `packages`。

</details>

---

### 提示词广场

`PROMPT_GALLERY_MODE` 三种工作方式：

- `1` 常驻：Tab 始终显示
- `2` 私密：需要密码验证（密码来自后端环境变量 `PROMPT_GALLERY_PASSWORD`）
- `3` 关闭：完全不显示

提示词内容由后端 `backend/prompts.json` 维护，支持敏感词过滤（`backend/blacklist.json`）。

### 模型系统

FlyReq Image 采用**用户自定义模型**架构：

- **模型级配置**：每个图片模型和文本模型都独立保存协议、显示名称、模型 ID、API Key 与 Base URL
- **图像模型**：用户自由添加、编辑、删除，支持设置协议、显示名称、模型 ID、最大参考图数量、最大分辨率
- **Image 2 额外参数**：仅 OpenAI 图片模型显示，透明背景、质量、风格控件默认开启，用户可手动关闭
- **流式图片请求**：仅 OpenAI Images 协议显示，可对兼容接口发送 `stream=true`，用于降低 New API / Nginx / Cloudflare 长耗时图片生成时的 504 截断风险；上游不支持时任务直接返回错误
- **文字模型**：支持自定义扩展，兼容 Gemini 和 OpenAI Response
- **默认模型**：可为文本生图、图生图、反推提示词、Agent 等任务分别设置默认模型

#### 支持的模型与协议

| 类型 | 内置预设或兼容协议 | 可用能力 |
| --- | --- | --- |
| Google 图片模型 | Gemini 2.5 Flash Image、Gemini 3 Pro Image Preview、Gemini 3.1 Flash Image Preview、Gemini 3.1 Flash Lite Image | 文生图、图生图、模型允许的参考图数量与 1K 至 4K 输出；可按模型启用 `temperature` |
| OpenAI 图片模型 | GPT Image 2 及 OpenAI Images 兼容接口 | GPT Image 2 支持文生图、图生图、最多 16 张参考图、1K 至 4K、质量/风格/透明背景/PNG-JPEG-WebP、自定义尺寸和流式图片请求；兼容接口的可用参数取决于其上游实现 |
| xAI 图片模型 | Grok Imagine、Grok Imagine Quality | xAI Imagine 专用请求格式、1K 或 2K、预设支持的宽高比 |
| 文字模型 | Google `generateContent`、OpenAI Responses 兼容接口 | 提示词反推、提示词优化、Agent 多轮对话与图像生成方案 |
| 自定义模型 | `google` 或 `openai` 协议的兼容服务 | 自定义模型 ID、Base URL、API Key、最大参考图数、最大输出规格和能力开关 |

预设是能力边界的配置模板，不会限制接入方使用兼容服务；填写实际 Base URL、模型 ID 和 API Key 后即可使用。Google 与 xAI 图片接口不发送 `stream=true`，以保持各自协议约束；OpenAI Images 兼容接口默认可开启流式请求。

#### 与众不同的工作流能力

- **Agent 按意图选模型**：Agent 会结合用户指定的分辨率、当前可用模型和参考图比例，选择能满足要求且规格合适的图片模型，并把布局参数归一化为该模型支持的范围。
- **一处配置，多处生效**：外部系统可通过 URL 预填图片、文本或视频模型，并要求用户确认后才保存；部署者可通过环境变量为新用户提供首个默认图片模型、品牌名称、Logo 和浏览器图标。
- **上游兼容与诊断并存**：服务端可以把用户填写的公网 Base URL 改写为容器内网地址，同时保留用户原始配置；上游返回错误时保留原始内容并标注来源。
- **任务结果可恢复**：任务经 SQLite 队列持久化，WebSocket 实时同步状态，断线后自动重连并回退轮询；图片落盘保存，历史任务可重试、下载、备份和恢复。

### 外部链接预填模型配置

外部站点可以通过 URL 预填一个图片、文本或视频模型。页面会自动打开“设置”，把参数填入对应模型表单，然后立即清理地址栏中的全部配置参数。用户确认后仍需手动保存，外链导入不会自动写入 `localStorage`。

URL 只需要一个 `provider` 参数，内容是 JSON 字符串。下面使用裸 JSON 方便阅读；生产接入必须使用 `encodeURIComponent(JSON.stringify(payload))` 生成 URL 编码值，避免特殊字符被浏览器、代理或聊天工具改写。

#### 图片模型示例

```json
{
  "type": "image",
  "preset": "gpt-image-2",
  "provider": "openai",
  "modelKey": "flyreq-gpt-image-2",
  "name": "FlyReq",
  "modelId": "gpt-image-2",
  "baseUrl": "https://flyreq.com",
  "apiKey": "YOUR_API_KEY",
  "maxRefImages": 16,
  "maxOutputSize": "4K",
  "supportsTemperature": false,
  "streamImages": true
}
```

URL编码JSON:
```text
https://image.flyreq.com/zh/?provider=%7B%22type%22%3A%22image%22%2C%22preset%22%3A%22gpt-image-2%22%2C%22provider%22%3A%22openai%22%2C%22modelKey%22%3A%22flyreq-gpt-image-2%22%2C%22name%22%3A%22FlyReq%22%2C%22modelId%22%3A%22gpt-image-2%22%2C%22baseUrl%22%3A%22https%3A%2F%2Fflyreq.com%22%2C%22apiKey%22%3A%22YOUR_API_KEY%22%2C%22maxRefImages%22%3A16%2C%22maxOutputSize%22%3A%224K%22%7D
```

```text
https://image.flyreq.com/zh/?provider={"type":"image","preset":"gpt-image-2","provider":"openai","modelKey":"flyreq-gpt-image-2","name":"FlyReq","modelId":"gpt-image-2","baseUrl":"https://flyreq.com","apiKey":"YOUR_API_KEY","maxRefImages":16,"maxOutputSize":"4K"}
```

配置完整时，图片模型会成为文生图和图生图默认模型。

#### 文本模型示例

```json
{
  "type": "text",
  "provider": "openai",
  "modelKey": "flyreq-text-default",
  "name": "FlyReq Text",
  "modelId": "gpt-5.4-mini",
  "baseUrl": "https://flyreq.com",
  "apiKey": "YOUR_API_KEY",
  "note": "OpenAI Responses 兼容文本模型"
}
```

```text
https://image.flyreq.com/zh/?provider={"type":"text","provider":"openai","modelKey":"flyreq-text-default","name":"FlyReq Text","modelId":"gpt-5.4-mini","baseUrl":"https://flyreq.com","apiKey":"YOUR_API_KEY","note":"OpenAI Responses 兼容文本模型"}
```

配置完整时，文本模型会成为 Agent、反推提示词、提示词优化和图片描述的初始默认模型；用户保存前可以分别调整。文本模型支持 `openai` 和 `google`。

#### 视频模型示例

```json
{
  "type": "video",
  "protocol": "openai",
  "modelKey": "flyreq-video-default",
  "name": "FlyReq Video",
  "modelId": "sora-2",
  "baseUrl": "https://api.openai.com",
  "apiKey": "YOUR_API_KEY"
}
```

```text
https://image.flyreq.com/zh/?provider={"type":"video","protocol":"openai","modelKey":"flyreq-video-default","name":"FlyReq Video","modelId":"sora-2","baseUrl":"https://api.openai.com","apiKey":"YOUR_API_KEY"}
```


#### 字段与行为

| 字段 | 说明 |
| --- | --- |
| `type` | 模型类型：`image`、`text` 或 `video`；省略时为兼容旧链接默认使用 `image` |
| `modelKey` | 可选，稳定模型 ID；存在同 ID 时更新该模型 |
| `provider` / `protocol` | 图片、文本支持 `openai` 或 `google`；视频支持 `new-api`、`openai` 或 `xai`。新视频链接使用 `protocol`，历史 `provider=openai` 保留旧版端点行为 |
| `name` | 显示名称 |
| `modelId` | 上游模型 ID |
| `baseUrl` | 上游 Base URL |
| `apiKey` | API Key |
| `preset` | 仅图片模型，可选内置模板，如 `gpt-image-2` |
| `maxRefImages` | 仅图片模型，最大参考图数量 |
| `maxOutputSize` | 仅图片模型：`512`、`1K`、`2K`、`4K` |
| `supportsTemperature` | 仅图片模型，上游兼容时允许发送 Gemini `temperature` |
| `streamImages` | 仅图片模型，启用 OpenAI Images 兼容流式请求 |
| `note` | 仅文本模型，可选的协议或部署说明 |

匹配规则：优先按 `modelKey` 更新已有模型；没有 `modelKey` 时，按 `name + modelId + baseUrl` 匹配；仍未匹配则新增草稿。不完整配置会作为未激活草稿保留，用户可以补齐后保存。旧版 `configureModel=1&type=...` 多参数链接仍支持三种类型，识别后会删除所有配置参数。

安全提示：应用清理 URL 前，API Key 仍可能短暂出现在浏览器历史、代理日志、聊天预览和 Referer 信息中。推荐使用短期 Key，或在外链中省略 `apiKey`，让用户在本地填写。

### 任务系统

- 提交后入队，服务端并发处理（默认上限 50，可通过 `FLYREQ_TASK_CONCURRENCY` 调整）
- 浏览器通过 **WebSocket** 实时接收任务/队列状态，断线自动重连，失败 5 次后回退 **HTTP 轮询**（30 秒间隔）
- 任务结果本地落盘（`backend/flyreq-images/`），HTTP 路由 `/api/flyreq/images/:taskId/:index` 直接提供
- 任务 TTL 12 小时，过期自动清理（5 分钟一次）
- 服务重启时把残留"处理中"任务标记为失败并删除产物，避免幽灵任务

### 体验与工程化

- PWA（`next-pwa`），可安装到桌面
- 三端兼容 UI：桌面端、平板端、移动端自适应布局，提供一致的用户体验
- 暗色 / 亮色主题切换
- 宽屏 / 窄屏自适应布局（左侧垂直 Tab + 右侧内容）
- 历史任务持久化（IndexedDB / localStorage）
- 一键备份 / 恢复（`JSZip` 打包 localStorage + IndexedDB，支持跳过不兼容旧配置并恢复其余数据）
- 历史图片懒加载（`@tanstack/react-virtual`）
- 随机图、Toast 通知、确认对话框

---




## ⚙️ 环境变量（`backend/.env`）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3001` | 监听端口 |
| `HOSTNAME` | 否 | `0.0.0.0` | 绑定地址，`localhost`/`127.0.0.1` 仅本机 |
| `NODE_ENV` | **是** | `production` | **必须为 `production`**，否则会走 Next dev 模式 |
| `FLYREQ_TASK_DB` | 否 | `./flyreq-tasks.sqlite` | SQLite 文件路径，建议放到持久化目录 |
| `FLYREQ_TASK_CONCURRENCY` | 否 | `50` | 最大并发任务数（绝对上限 50） |
| `FLYREQ_MAX_QUEUE_SIZE` | 否 | `200` | 全局最大待处理任务数 |
| `FLYREQ_RATE_LIMIT_WINDOW_MS` | 否 | `60000` | 创建任务速率限制窗口，单位毫秒 |
| `FLYREQ_RATE_LIMIT_MAX_REQUESTS_PER_IP` | 否 | `20` | 单 IP 在一个窗口内最多创建多少个任务 |
| `FLYREQ_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY` | 否 | `20` | 单 API Key 在一个窗口内最多创建多少个任务 |
| `FLYREQ_MAX_PENDING_TASKS_PER_IP` | 否 | `20` | 单 IP 最多同时拥有多少个待处理任务 |
| `FLYREQ_MAX_PENDING_TASKS_PER_API_KEY` | 否 | `20` | 单 API Key 最多同时拥有多少个待处理任务 |
| `FLYREQ_RATE_LIMIT_RETRY_AFTER_SECONDS` | 否 | `30` | 队列满/限流时响应头 `Retry-After` 秒数 |
| `FLYREQ_IMAGE_DIR` | 否 | `backend/flyreq-images/` | 任务产物落盘目录 |
| `FLYREQ_REMOTE_IMAGE_MAX_BYTES` | 否 | `52428800` | 服务端下载远程生成图片的最大字节数，范围为 1024 至 209715200 |
| `FLYREQ_BASE_URL_REWRITE_MAP` | 否 | 空 | Base URL 出站改写表；例如 `{"https://flyreq.com":"http://new-api:3000"}` |
| `FLYREQ_OUTBOUND_USER_AGENT` | 否 | `FlyReq-Image-Studio/1.5.1` | 上游请求携带的稳定服务标识；请配置为部署方可追溯的产品名称，不要伪造浏览器或第三方服务身份 |
| `FLYREQ_FILE_LOG_ENABLED` | 否 | `true` | 是否将全部后端标准日志按日期写入文件；`false`、`0`、`no`、`off` 关闭 |
| `FLYREQ_LOG_DIR` | 否 | `backend/logs/application` | 按日期分割的后端应用 JSONL 日志目录；Docker Compose 使用 `/app/backend/logs/application` |
| `FLYREQ_PLATFORM_NAME` | 否 | `FlyReq Image` | 平台名称；用于页面标题、Header、设置页和 PWA 名称 |
| `FLYREQ_PLATFORM_LOGO_URL` | 否 | `/favicon.png` | Header Logo；建议正方形且至少 `128x128`，支持 PNG/WebP/SVG |
| `FLYREQ_PLATFORM_ICON_URL` | 否 | `/favicon.png` | 浏览器 favicon；建议使用 `48x48` PNG 或 ICO，不作为 PWA 安装图标 |
| `FLYREQ_PWA_ICON_192_URL` | 否 | `/icon-192.png` | PWA 普通图标；必须为 `192x192` PNG |
| `FLYREQ_PWA_ICON_512_URL` | 否 | `/icon-512.png` | PWA 高清普通图标；必须为 `512x512` PNG |
| `FLYREQ_PWA_MASKABLE_ICON_512_URL` | 否 | `/icon-maskable-512.png` | PWA Maskable 图标；必须为 `512x512` PNG，重要内容放在中心 80% 安全区域 |
| `FLYREQ_IMAGE_MODEL_KEY_GUIDE_TITLE` | 否 | `还没有图片模型 API Key？` | 设置页图片模型 Key 指引标题 |
| `FLYREQ_IMAGE_MODEL_KEY_GUIDE_DESCRIPTION` | 否 | FlyReq 默认说明 | 设置页图片模型 Key 指引描述 |
| `FLYREQ_IMAGE_MODEL_KEY_GUIDE_CTA_LABEL` | 否 | `前往 flyreq.com` | 设置页图片模型 Key 指引按钮文字 |
| `FLYREQ_IMAGE_MODEL_KEY_GUIDE_URL` | 否 | `https://flyreq.com` | 设置页图片模型 Key 指引跳转地址 |
| `FLYREQ_DEFAULT_IMAGE_MODEL_KEY` | 否 | `flyreq-gpt-image-2` | 首次默认图片模型的稳定内部 Key |
| `FLYREQ_DEFAULT_IMAGE_MODEL_NAME` | 否 | `FlyReq` | 首次默认图片模型的显示名称 |
| `FLYREQ_DEFAULT_IMAGE_MODEL_PROTOCOL` | 否 | `openai` | 首次默认图片模型协议：`openai` 或 `google` |
| `FLYREQ_DEFAULT_VIDEO_MODEL_KEY` | 否 | `flyreq-sora-2` | 首次默认视频模型的稳定内部 Key |
| `FLYREQ_DEFAULT_VIDEO_MODEL_NAME` | 否 | `FlyReq` | 首次默认视频模型的显示名称 |
| `FLYREQ_DEFAULT_VIDEO_MODEL_PROTOCOL` | 否 | `openai` | 首次默认视频模型协议：`new-api`、`openai` 或 `xai` |
| `FLYREQ_DEFAULT_VIDEO_MODEL_BASE_URL` | 否 | `https://flyreq.com` | 首次默认视频模型的 Base URL |
| `FLYREQ_DEFAULT_VIDEO_MODEL_MODEL_ID` | 否 | `sora-2` | 首次默认视频模型的上游模型 ID |
| `FLYREQ_VIDEO_PROTOCOL_CONFIG_OVERRIDES` | 否 | 空 | 视频协议能力的 JSON Merge Patch 覆盖；对象递归合并，数组整体替换，`null` 删除字段 |
| `FLYREQ_VIDEO_UPSTREAM_LOG_ENABLED` | 否 | `true` | 是否记录视频上游创建、轮询和下载阶段的每次请求与响应；`false`、`0`、`no`、`off` 关闭 |
| `FLYREQ_VIDEO_UPSTREAM_LOG_MAX_CHARS` | 否 | `65536` | 单条视频上游响应正文的最大日志字符数，范围 `1024-1048576` |
| `FLYREQ_VIDEO_UPSTREAM_LOG_DIR` | 否 | `backend/logs/video-upstream` | 按日期分割的视频上游 JSONL 日志目录；Docker Compose 使用 `/app/backend/logs/video-upstream` |
| `FLYREQ_IMAGE_UPSTREAM_LOG_ENABLED` | 否 | `true` | 是否记录图片上游生成阶段的每次请求与响应；`false`、`0`、`no`、`off` 关闭 |
| `FLYREQ_IMAGE_UPSTREAM_LOG_MAX_CHARS` | 否 | `65536` | 单条图片上游响应正文的最大字符数，范围 `1024-1048576` |
| `FLYREQ_IMAGE_UPSTREAM_LOG_DIR` | 否 | `backend/logs/image-upstream` | 按日期分割的图片上游 JSONL 日志目录；Docker Compose 使用 `/app/backend/logs/image-upstream` |
| `FLYREQ_DEFAULT_IMAGE_MODEL_BASE_URL` | 否 | `https://flyreq.com` | 首次默认图片模型的 Base URL |
| `FLYREQ_DEFAULT_IMAGE_MODEL_MODEL_ID` | 否 | 空 | 实际模型 ID；留空时使用预设模型 ID 映射 |
| `FLYREQ_DEFAULT_IMAGE_MODEL_PRESET` | 否 | `gpt-image-2` | 内置图片预设 ID，决定模型能力边界 |
| `FLYREQ_DEFAULT_IMAGE_MODEL_MAX_REF_IMAGES` | 否 | `16` | 最大参考图数量，范围 `1-16` |
| `FLYREQ_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE` | 否 | `4K` | 最大输出规格：`512`、`1K`、`2K`、`4K` |
| `FLYREQ_DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS` | 否 | `true` | 是否默认启用 GPT Image 2 额外参数 |
| `FLYREQ_DEFAULT_IMAGE_MODEL_SUPPORTS_TEMPERATURE` | 否 | `false` | Google 图片模型是否默认支持 temperature |
| `FLYREQ_DEFAULT_IMAGE_MODEL_STREAM_IMAGES` | 否 | `true` | 是否默认开启 OpenAI GPT Image 2 流式图片请求 |
| `PROMPT_GALLERY_MODE` | 否 | `2` | `1` 常驻 / `2` 私密密码（点七下标题） / `3` 关闭 |
| `PROMPT_GALLERY_PASSWORD` | 否 | 空 | 提示词广场私密模式密码；为空时私密模式可直接开启 |

> `.env` 修改后大部分运行时配置**实时生效**（任务并发、限流、队列容量、接单开关、Base URL 出站改写、广场模式、图片模型 Key 指引），无需重启；`PORT`、`HOSTNAME`、`NODE_ENV` 这类启动级配置仍需重启。

### 视频协议配置

视频工作台支持 `new-api`、OpenAI Videos（Sora）和 `xai` 三种协议。协议的时长、尺寸、宽高比、清晰度、参考图数量以及设置页默认 Base URL/模型 ID，统一定义在 `backend/video-protocol-capabilities.json`。后端在 `/api/flyreq/config` 下发合并后的 `videoProtocols`，前端据此显示控件，后端再使用同一配置校验请求。

默认视频模型使用 `FLYREQ_DEFAULT_VIDEO_MODEL_PROTOCOL=openai` 和 `FLYREQ_DEFAULT_VIDEO_MODEL_MODEL_ID=sora-2`。可选协议值如下：

- `new-api`：New API 通用视频协议，创建端点为 `/v1/video/generations`。
- `openai`：OpenAI Videos（Sora）协议，创建端点为 `/v1/videos`，这是默认值。
- `xai`：xAI Videos 协议，创建端点为 `/v1/videos/generations`。

切换协议时必须同时配置与上游匹配的 `FLYREQ_DEFAULT_VIDEO_MODEL_BASE_URL` 和 `FLYREQ_DEFAULT_VIDEO_MODEL_MODEL_ID`。

| 协议 | 官方核对结果 | 配置约束来源 |
| --- | --- | --- |
| [New API 通用视频](https://www.newapi.ai/zh/docs/api/ai-model/videos/createvideogeneration) | 使用 `POST /v1/video/generations`、`GET /v1/video/generations/{task_id}`，请求字段为 `model`、`prompt`、`image`、`duration`、`width`、`height` | 官方未定义跨上游模型统一的时长和尺寸上限，因此配置标记为 `workspace-default`；内置 1-60 秒和尺寸列表是工作台默认边界，可用环境变量覆盖 |
| [OpenAI Videos（Sora）](https://developers.openai.com/api/docs/guides/video-generation) | 使用 `POST /v1/videos`、`GET /v1/videos/{video_id}`、`GET /v1/videos/{video_id}/content`；支持 Sora 官方时长/尺寸，参考图采用 `input_reference` | `official`；后端校验 JPEG/PNG/WebP 格式、文件大小和数量，不限制参考素材像素尺寸 |
| [xAI Videos](https://docs.x.ai/developers/model-capabilities/video/generation) | 使用 `POST /v1/videos/generations`、`GET /v1/videos/{request_id}`；时长 1-15 秒，支持官方宽高比与 480p/720p，1.5 模型图生视频支持 1080p | `official`；图生视频的 `image` 按官方要求发送 URL、data URI 或 `file_id` 字符串，不包装为对象 |

部署差异必须通过 `FLYREQ_VIDEO_PROTOCOL_CONFIG_OVERRIDES` 配置。例如，把 xAI 的页面预设时长替换为 3、6、9 秒：

```env
FLYREQ_VIDEO_PROTOCOL_CONFIG_OVERRIDES={"protocols":{"xai":{"parameters":{"duration":{"presets":[3,6,9]}}}}}
```

覆盖遵循 JSON Merge Patch：对象递归合并，数组整体替换，`null` 删除字段。配置版本、未知协议和不完整能力会在服务端被拒绝。历史注册表中的非法或旧视频协议会统一归一化为当前的 `openai` 协议；`new-api`、`openai` 和 `xai` 三种协议都会发送 `aspect_ratio`，各协议仍按自身能力配置决定尺寸、清晰度及其他控件。

---

## 📡 API 速览

后端暴露在 `/api/flyreq/*` 路径下，前端在同源调用。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/flyreq/tasks/batch` | 批量创建独立任务，按图片序号返回 `taskIds`（202） |
| `POST` | `/api/flyreq/tasks` | 创建任务，返回 `{ taskId }`（202） |
| `GET` | `/api/flyreq/tasks/:id` | 查询任务状态与结果 |
| `POST` | `/api/flyreq/tasks/:id/ack` | 续期：把 TTL 延长 2 分钟 |
| `GET` | `/api/flyreq/queue-status` | 当前并发 / 排队 / 接收状态 |
| `GET` | `/api/flyreq/prompts` | 提示词广场内容 |
| `GET` | `/api/flyreq/blacklist` | 敏感词列表 |
| `GET` | `/api/flyreq/config` | 前端配置（如 `promptGalleryMode`） |
| `GET` | `/api/flyreq/manifest.webmanifest` | 运行时 PWA manifest |
| `GET` | `/api/flyreq/images/:taskId/:index/:subIndex` | 任务产物图片；省略 `subIndex` 时读取第 0 张 |
| `WS` | `/api/flyreq/ws` | 实时任务 / 队列订阅 |

### 任务状态

- `排队中`：等待调度
- `processing`：正在调用上游 API
- `completed`：成功，`result.images` 包含产物链接
- `failed`：失败，详见 `error`
- `expired`：超过 TTL

---

## ❓ 常见问题

**为什么生产环境不用 `next start`？**
项目使用 `output: 'export'`，构建产物是纯静态 `out/`。`server.js` 同时托管静态文件 + 任务 API，不再依赖 `next start`。

**只部署 `out/` 能用吗？**
UI 可以打开，但任务提交、Agent、历史同步全部依赖 `/api/flyreq/*`，必须运行 `server.js`。

**数据库需要单独备份吗？**
首次部署不需要，服务启动会自建。任务数据要保留就备份 `flyreq-tasks.sqlite`（含 WAL/SHM）以及 `flyreq-images/`。重启后残留任务会被自动标记为失败并清理产物。

**如何临时停止接收新任务（不停服务）？**
编辑 `.env`：

```env
FLYREQ_ACCEPT_NEW_TASKS=false
```

保存即生效。等待在飞任务完成后即可重启升级。再次开启设为 `true` 或留空。

**任务多久会过期？**
创建后 12 小时；前端在拿到结果后会调用 `/ack` 续期 2 分钟，给下载留时间。超过 TTL 服务端删除数据库记录与产物图片。

**New API 已经生成成功，为什么前端仍然显示 504？**
如果 FlyReq Image 后端通过 Cloudflare 橙云域名访问 New API，长时间无响应的图片生成请求可能被 Cloudflare / Nginx 网关提前截断，New API 控制台仍可能显示上游任务成功。推荐优先让 FlyReq Image 后端使用 New API 的 Docker 内网地址或灰云域名；同时可在对应图片模型中开启“流式图片请求”，让兼容接口通过 `stream=true` 持续返回事件，降低 504 概率。上游不支持该参数时，任务会直接失败并保留错误信息。

---

## 🙏 致谢

本项目的无限画布工作区功能基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas) 项目开发，感谢原作者 [basketikun](https://github.com/basketikun) 的开源贡献。感谢[tianjiangqiji](https://github.com/tianjiangqiji/nova-image-studio)的开源UI

感谢 [Linux.do](https://linux.do/) 社区的支持。


---

## Star History

<a href="https://www.star-history.com/?repos=doudou770%2Fflyreq-image-studio&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=doudou770/flyreq-image-studio&type=date&theme=dark&legend=top-left&sealed_token=9dZ2kL1_BV4KpieyukOjBrWI3rQ-tdq9WN0wqR46Pz1sBxU5ptf32X4FcKFsxFcnD7lVvu2XnhlOsGKRYtOg4_GiXLKgQ1W14VOvTb7CVgIW4p_i4X5elQ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=doudou770/flyreq-image-studio&type=date&legend=top-left&sealed_token=9dZ2kL1_BV4KpieyukOjBrWI3rQ-tdq9WN0wqR46Pz1sBxU5ptf32X4FcKFsxFcnD7lVvu2XnhlOsGKRYtOg4_GiXLKgQ1W14VOvTb7CVgIW4p_i4X5elQ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=doudou770/flyreq-image-studio&type=date&legend=top-left&sealed_token=9dZ2kL1_BV4KpieyukOjBrWI3rQ-tdq9WN0wqR46Pz1sBxU5ptf32X4FcKFsxFcnD7lVvu2XnhlOsGKRYtOg4_GiXLKgQ1W14VOvTb7CVgIW4p_i4X5elQ" />
 </picture>
</a>

---


## 📄 许可证

本项目采用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）开源许可证。

这意味着：

- ✅ 你可以自由使用、修改和分发本软件
- ✅ 你可以将本软件用于商业用途
- ⚠️ 如果你修改了本软件并通过网络提供服务，你必须公开修改后的源代码
- ⚠️ 基于本软件的衍生作品必须使用相同的 AGPL-3.0 许可证

详细条款请参阅 [LICENSE](LICENSE) 文件。

---

<div align="center">

**[⬆ 回到顶部](#flyreq-image-studio)**

</div>

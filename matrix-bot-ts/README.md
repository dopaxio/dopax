# matrix-agent-ts

一个基于 `matrix-bot-sdk` 的 TypeScript Agent 工程，可以用同一套代码跑多个 Matrix agent 账号，每个账号绑定一个 provider。

## 功能

- 自动接受房间邀请
- 启动前通过 `owner Matrix access token + plat.dopax.io` 交换 agent 运行 token
- 支持 provider 选择：
  - `codex`
  - `claude`
  - `gemini`
  - `copilot`
  - `opencode`
- 支持 room 级运行模式：
  - `shared`
  - `workspace`
  - `container`
- 持久化：
  - sync token
  - access token
  - room -> provider session 映射（当前完整支持 Codex）
  - room -> runtime 绑定（mode / workspace / container）
  - 已处理 poll 列表
- 支持 Matrix thread 对应独立 Codex 会话
- 支持 poll 自动投票
- 主时间线支持 typing，thread 内不发 typing
- 支持 provider 命令桥接
- 支持本地命令：
  - `!help`
  - `!ping`
  - `!echo <text>`
  - `!whoami`
  - `!rooms`

## 使用

1. 安装依赖

```bash
npm install
```

2. 复制环境变量

```bash
cp .env.example .env
```

3. 在 `.env` 里填写 bootstrap 所需身份交换配置：

- `AGENT_SERVER_URL`
- `OWNER_ACCESS_TOKEN`

并配置 agent 对应的 provider：

- `PROVIDER`
- `PROVIDER_BIN`
- `PROVIDER_CWD`
- `DEFAULT_ROOM_MODE`
- `WORKSPACES_ROOT`

连接模式支持两种：

- `CONNECT_MODE=remote`
  - 默认连接 `Synapse`：`http://matrix.dev.localhost`
- `CONNECT_MODE=local`
  - 默认连接 `Tuwunel`：`http://tuwunel.dev.localhost`

如果你显式设置了 `HOMESERVER_URL`，它会覆盖 `CONNECT_MODE` 的默认地址。

仓库里也带了多 agent 示例配置：

- [examples/codex.env.example](examples/codex.env.example)
- [examples/claude.env.example](examples/claude.env.example)
- [examples/gemini.env.example](examples/gemini.env.example)
- [examples/copilot.env.example](examples/copilot.env.example)
- [examples/opencode.env.example](examples/opencode.env.example)

4. 启动

```bash
npm run start
```

开发模式：

```bash
npm run dev
```

## 多实例管理

项目内置了一个 launchd 管理脚本：

- [scripts/manage-instance.sh](scripts/manage-instance.sh)

常用命令：

```bash
./scripts/manage-instance.sh list
./scripts/manage-instance.sh start codex
./scripts/manage-instance.sh start claude
./scripts/manage-instance.sh stop codex
./scripts/manage-instance.sh status codex
```

Matrix 账号批量注册脚本：

- [scripts/register_matrix_user.py](scripts/register_matrix_user.py)

## Supervisor

`supervisor` 负责按模式启动本地服务：

- `local`
  - 启动 `Tuwunel`
  - 等健康检查通过
  - 再启动 agent
- `remote`
  - 不启动 `Tuwunel`
  - 直接启动 agent

入口：

```bash
npm run supervisor:start -- ./supervisor/local.example.json
```

样例配置：

- [supervisor/local.example.json](supervisor/local.example.json)
- [supervisor/remote.example.json](supervisor/remote.example.json)

demo 脚本：

- [start-supervisor-demo.sh](scripts/start-supervisor-demo.sh)
- [start-supervisor-demo-remote.sh](scripts/start-supervisor-demo-remote.sh)

本地 demo 下，`Tuwunel` 由：

- [run-tuwunel-supervisor-demo.sh](scripts/run-tuwunel-supervisor-demo.sh)

拉起。

## 说明

- 默认使用 `SimpleFsStorageProvider`，会把 SDK 状态写到 `STORAGE_PATH`
- 其他状态文件会写到 `STATE_DIR`
- agent 启动时会拿 `OWNER_ACCESS_TOKEN` 调 `AGENT_SERVER_URL` 的 `/v1/me/agents/bootstrap`
  先让 `plat.dopax.io` 用 `/_matrix/client/v3/account/whoami` 鉴权 owner
  再返回 agent 自己的运行 token 给当前进程
- agent 会优先复用本地缓存的 agent runtime token；只有 token 失效时才会拿 `OWNER_ACCESS_TOKEN` 去 `plat.dopax.io` 重新换一枚
- agent 进程始终使用 agent 自己的 runtime token 登录 Matrix，不再走旧的本地用户名/密码登录
- 交换得到的 agent token 会缓存到 `STATE_DIR/access-token.txt`
- 交换得到的 agent 身份元数据会缓存到 `STATE_DIR/runtime-identity.json`
- `CONNECT_MODE` 用来切换 agent 连到哪套 Matrix 服务端：
  - `remote` -> `Synapse`
  - `local` -> `Tuwunel`
- 如果只想让 agent 在固定房间工作，可以把 `ROOM_ALLOWLIST` 设成逗号分隔的 room id 列表
- 当前建议是：一个 Matrix agent 账号对应一个 provider，并为每个实例准备独立的 `STATE_DIR` / `STORAGE_PATH`
- `PROVIDER_BIN` 指向对应 CLI，例如：
  - `codex`
  - `claude`
  - `gemini`
  - `copilot`
  - `opencode`
  - `/absolute/path/to/provider-cli`
- `CODEX_APPROVAL_POLICY` 和 `CODEX_SANDBOX_POLICY` 只对 `PROVIDER=codex` 生效
- 当前 provider 都走统一的会话状态模型；`codex` 使用 `thread` 语义，其他 provider 使用 `session` 语义
- 如果房间想单独切模式/模型，可以直接在聊天里发：
  - `!room show`
  - `!room mode shared`
  - `!room mode workspace`
  - `!room mode container`
  - `!room model <name>`
  - `!room workspace-key <key>`
  - `!room container-image <image>`
- 三种模式含义：
  - `shared`: 所有 room 共用实例默认工作目录
  - `workspace`: 每个 room 自动分配独立工作目录
  - `container`: 每个 room 复用一个独立 Docker 容器和工作目录
- `container` 模式要求：
  - `codex` / `claude` / `gemini` / `opencode` 支持 `container`
  - `copilot` 明确不支持 `container`
  - 镜像里已经安装好对应 provider CLI
  - `CONTAINER_PROVIDER_BIN` 能在容器里执行
  - `codex` 推荐先构建项目内的新 runtime 镜像：

```bash
./scripts/build-codex-runtime-image.sh
```

- `claude` / `gemini` / `opencode` 现在各自有独立 runtime 镜像：

```bash
./scripts/build-claude-runtime-image.sh
./scripts/build-gemini-runtime-image.sh
./scripts/build-opencode-runtime-image.sh
```

- 支持 `container` 的 provider 现在都会为每个 room 单独创建：
  - 一个 Docker 容器
  - 一个 host workspace 目录
  - 一个 host provider state 目录
- `codex` 默认会把 `CONTAINER_CODEX_SEED_HOME` 或 `CONTAINER_SEED_HOME` 首次复制到每个 room 的容器状态目录
- `claude` 会为每个 room 单独准备 `~/.claude` 和 `~/.claude.json`
- `gemini` 会为每个 room 单独准备 `~/.gemini`
- `opencode` 会为每个 room 单独准备 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` 下的 `opencode` 数据
- 如果要切换到本地 clone 的 SDK，可以把 `package.json` 里的 `matrix-bot-sdk` 改成：

```json
"matrix-bot-sdk": "file:../matrix-bot-sdk"
```

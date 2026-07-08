# PMBrain 新用户首次安装使用 Docker Postgres

本文面向第一次安装 PMBrain 桌面端的 Windows 用户。适用场景：

- 点击“PGLite 零配置”后出现 `PMBrain command exited with code 3221225501`、`Aborted()` 或类似启动失败。
- 用户电脑的 PGLite / WASM 运行环境不稳定。
- 知识库文件较多，希望使用更稳定的 Postgres 数据库。

Docker Postgres 模式的核心思路是：先在本机启动一个带 `pgvector` 扩展的 Postgres 容器，再让 PMBrain 桌面端连接它。

## 准备条件

需要提前安装：

- Windows 10 或 Windows 11，64 位系统。
- Docker Desktop。
- Docker Desktop 已能正常启动。

如果 Docker Desktop 提示需要 WSL2，请按 Docker Desktop 的提示安装并重启电脑。Docker Desktop 正常后，再继续下面步骤。

## 第一步：启动 Postgres 数据库

打开 PowerShell，执行：

```powershell
docker run -d `
  --name pmbrain-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=pmbrain `
  -p 5433:5432 `
  -v pmbrain-postgres-data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16
```

这条命令会创建一个名为 `pmbrain-postgres` 的数据库容器：

- 本机连接端口：`5433`
- 用户名：`postgres`
- 密码：`postgres`
- 数据库名：`pmbrain`
- 数据卷：`pmbrain-postgres-data`

确认容器正在运行：

```powershell
docker ps --filter "name=pmbrain-postgres"
```

如果能看到 `pmbrain-postgres` 且状态为 `Up`，说明数据库已经启动。

## 第二步：确认 pgvector 可用

执行：

```powershell
docker exec -it pmbrain-postgres psql -U postgres -d pmbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

正常情况下会看到 `CREATE EXTENSION` 执行成功。重复执行也没有关系。

## 第三步：在 PMBrain 桌面端选择 Docker Postgres

启动 PMBrain 桌面端。首次安装时会进入配置向导。

在“数据库”区域选择：

```text
Docker Postgres
```

连接地址填写：

```text
postgresql://postgres:postgres@127.0.0.1:5433/pmbrain
```

然后继续填写：

- 本地知识库目录：例如 `C:\Users\你的用户名\Documents\PMBrain`
- 普通模型：按实际 API Key 选择，例如 `mimo:mimo-v2-pro`
- 向量化模型：例如 `zhipu:embedding-3`
- 向量维度：智谱 `embedding-3` 填 `1024`
- API Key：填写对应厂商的 Key

最后点击：

```text
保存配置并启动
```

首次启动会执行数据库迁移，可能需要等待几十秒。不要重复点击按钮，也不要重复启动 PMBrain。

## 第四步：进入管理台

初始化成功后，桌面端会进入 PMBrain 管理台。

如果页面没有自动跳转，可以从 PMBrain 菜单中点击“打开管理控制台”。

## 常见问题

### Docker 命令提示找不到 docker

说明 Docker Desktop 没有安装，或安装后还没有重新打开 PowerShell。先启动 Docker Desktop，再重新打开 PowerShell。

### Docker Desktop 提示 WSL2 未安装

按 Docker Desktop 的提示安装 WSL2，然后重启电脑。Docker Desktop 能正常启动后，再执行本文命令。

### 端口 5433 被占用

可以换一个本机端口，例如 `55433`：

```powershell
docker run -d `
  --name pmbrain-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=pmbrain `
  -p 55433:5432 `
  -v pmbrain-postgres-data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16
```

PMBrain 连接地址同步改成：

```text
postgresql://postgres:postgres@127.0.0.1:55433/pmbrain
```

### 容器已经存在

如果之前创建过容器，直接启动它：

```powershell
docker start pmbrain-postgres
```

不要删除数据卷，数据卷里保存着 PMBrain 数据库内容。

### 想停止数据库

```powershell
docker stop pmbrain-postgres
```

下次使用 PMBrain 前，再执行：

```powershell
docker start pmbrain-postgres
```

### PGLite 报错后能不能改用 Docker Postgres

可以。首次配置还没有成功时，直接在配置向导里改选 Docker Postgres 并填写连接地址即可。

如果已经写入过配置，可以重新打开“配置与 MCP 接入”，把数据库模式切换为 Docker Postgres。切换数据库不会自动迁移 PGLite 数据；如果旧 PGLite 里已有重要数据，需要先单独做迁移规划。

## 推荐给新用户的最短说明

如果用户只是想尽快完成安装，可以直接发这一段：

```text
请先安装并启动 Docker Desktop，然后打开 PowerShell 执行：

docker run -d --name pmbrain-postgres -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pmbrain -p 5433:5432 -v pmbrain-postgres-data:/var/lib/postgresql/data pgvector/pgvector:pg16

启动 PMBrain 后，在数据库里选择 Docker Postgres，连接地址填：
postgresql://postgres:postgres@127.0.0.1:5433/pmbrain

然后填写知识库目录、模型和 API Key，点击“保存配置并启动”。
```

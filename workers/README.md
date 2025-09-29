# Cloudflare Worker 部署指南

**纯 R2 存储，无需额外依赖**

## 🚀 方案一：GitHub 自动部署（推荐）

**最简单，修改后自动部署**

### 部署步骤

#### 1. Fork 本仓库
1. 点击 GitHub 页面右上角 **Fork**
2. 保存到你的 GitHub 账号

#### 2. 连接 Cloudflare
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **创建应用程序** → **Workers** → **连接到 Git**
4. 选择你 Fork 的仓库
5. 配置构建设置：
   - **框架预设**：无
   - **构建命令**：留空（无需构建）
   - **构建输出目录**：`/`
   - **根目录**：`workers`
6. 点击 **保存并部署**

#### 3. 创建 R2 存储桶
1. 进入 **R2 Object Storage**
2. 点击 **创建存储桶**
3. 输入存储桶名称（如 `backup-bucket`）

#### 4. 绑定 R2 到 Worker
1. 回到 **Workers & Pages**
2. 选择刚创建的 Worker
3. 进入 **设置** → **函数** → **R2 存储桶绑定**
4. 点击 **添加绑定**
5. 填写：
   - **变量名称**：`R2_BUCKET`（必须与 wrangler.toml 中一致）
   - **R2 存储桶**：选择刚创建的存储桶
6. 点击 **保存**

**重要提示**：
- `wrangler.toml` 中已包含 R2 绑定占位符，防止部署时被删除
- **必须**在 Dashboard 中绑定实际的 R2 存储桶
- 变量名称必须为 `R2_BUCKET`

#### 5. 配置环境变量
1. 在 **设置** → **环境变量** 中添加：

**AUTH_TOKEN**（必需）：
```
变量名：AUTH_TOKEN
值：32位随机字符串
环境：生产
加密：✅ 勾选
```

生成方法（浏览器控制台运行）：
```javascript
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

**ALLOWED_ORIGINS**（推荐）：
```
变量名：ALLOWED_ORIGINS
值：https://www.nodeseek.com,https://www.deepflood.com
环境：生产
```

**重要提示**：
- `wrangler.toml` 中已包含这些环境变量的占位符，防止部署时被删除
- `AUTH_TOKEN` 在 `wrangler.toml` 中为空，**必须**在 Dashboard 中设置真实值
- `ALLOWED_ORIGINS` 已设置默认值，可根据需要在 Dashboard 中修改
- Dashboard 中的值会覆盖 `wrangler.toml` 的值

2. 点击 **保存**

#### 6. 部署完成
- Worker URL：`https://你的项目名.workers.dev`
- 或绑定自定义域名

#### 7. 配置前端脚本
1. 访问 NodeSeek/DeepFlood 私信页面
2. 点击脚本菜单 → **WebDAV 配置**
3. 勾选 **Cloudflare R2 备份**
4. 填写：
   - **Worker 基址**：`https://你的项目名.workers.dev`
   - **授权 Token**：与 `AUTH_TOKEN` 一致
   - **基础路径**：`/ns_df_messages_backup/`
5. 点击 **保存** → **立即备份**

---

## 📋 方案二：控制台编辑器（无 GitHub）

**适合不想用 GitHub 的用户**

### 部署步骤

1. **创建 R2 存储桶**
2. **创建 Worker**：Dashboard → Workers → 创建 Worker
3. **复制代码**：
   - 打开 [`r2-backup-worker.js`](r2-backup-worker.js)
   - 全选复制
4. **粘贴部署**：
   - 删除编辑器默认代码
   - 粘贴
   - 点击 **保存并部署**
5. **绑定 R2**：设置 → 绑定 → R2 存储桶（变量名：`R2_BUCKET`）
6. **配置环境变量**：`AUTH_TOKEN`、`ALLOWED_ORIGINS`

---

## 🔧 快速开发（本地调试）

**需要 Node.js 18+ 和 yarn**

```bash
# 安装依赖
cd workers
yarn install

# 本地开发服务器
yarn dev

# 部署到 Cloudflare
yarn wrangler login
yarn wrangler deploy
```

---

## ❓ 常见问题

### Q: GitHub 部署后如何更新代码？
A: 修改 GitHub 仓库代码后，Cloudflare 会自动重新部署。

### Q: 部署时遇到 "lockfile would have been modified" 错误？
A: 这是 Yarn 版本不匹配问题。解决方法：
1. 在项目根目录删除 `node_modules` 和 `yarn.lock`
2. 重新运行 `yarn install`
3. 提交新的 `yarn.lock` 到 GitHub
4. Cloudflare 会自动重新部署

### Q: 如何使用自定义域名？
A: Workers 设置 → 自定义域 → 添加域名

### Q: R2 免费额度是多少？
A: 每月 10GB 存储 + 100 万次 A 类操作免费

### Q: 如何查看部署日志？
A: Workers 页面 → 日志 → 实时日志

### Q: 支持其他 S3 兼容存储吗？
A: 当前版本仅支持 Cloudflare R2。R2 提供 S3 兼容 API，可满足大部分需求。
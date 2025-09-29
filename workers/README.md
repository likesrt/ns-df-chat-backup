# Cloudflare Worker 部署指南


## 📋 部署步骤

### 1. 创建 R2 存储桶
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **R2 Object Storage**
3. 点击 **创建存储桶**
4. 输入存储桶名称（如 `backup-bucket`）

### 2. 创建 Worker
1. 进入 **Workers & Pages**
2. 点击 **创建应用程序** → **创建 Worker**
3. 输入 Worker 名称（如 `ns-df-chat-backup`）
4. 点击 **部署**

### 3. 复制代码到 Worker
1. 点击 **编辑代码**
2. 打开本项目的 [`r2-backup-worker.js`](r2-backup-worker.js) 文件
3. 全选复制代码
4. 回到 Worker 编辑器，删除默认代码
5. 粘贴复制的代码
6. 点击右上角 **保存并部署**

### 4. 绑定 R2 存储桶
1. 返回 Worker 详情页
2. 进入 **设置** → **函数** → **R2 存储桶绑定**
3. 点击 **添加绑定**
4. 填写：
   - **变量名称**：`R2_BUCKET`（必须使用此名称）
   - **R2 存储桶**：选择第 1 步创建的存储桶
5. 点击 **保存**

### 5. 配置环境变量
1. 在 **设置** → **变量和机密** 中添加：

**AUTH_TOKEN**（必需）：
```
变量名：AUTH_TOKEN
类型：加密
值：32位随机字符串（见下方生成方法）
环境：生产
```

生成方法（浏览器控制台运行）：
```javascript
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

**ALLOWED_ORIGINS**（可选）：
```
变量名：ALLOWED_ORIGINS
类型：文本
值：https://www.nodeseek.com,https://www.deepflood.com
```
*如果不设置此变量，默认允许所有域名访问（等同于 `*`）。建议设置具体域名以提高安全性。*

2. 点击 **保存并部署**

### 6. 配置前端脚本
1. 访问 NodeSeek 或 DeepFlood 私信页面
2. 点击脚本菜单 → **备份设置**
3. 勾选 **Cloudflare R2 备份**
4. 填写：
   - **Worker 基址**：`https://你的worker名称.workers.dev` 或 `你的worker名称.workers.dev`（支持自动补全 https://）
   - **授权 Token**：与 `AUTH_TOKEN` 一致
   - **基础路径**：`/ns_df_messages_backup/`（默认）
5. 点击 **保存** → **立即备份**

---

## ❓ 常见问题

### Q: 如何更新 Worker 代码？
A: 进入 Worker 详情页 → 编辑代码 → 重新复制粘贴新代码 → 保存并部署

### Q: 如何使用自定义域名？
A: Workers 设置 → 触发器 → 自定义域 → 添加域名

### Q: R2 免费额度是多少？
A: 每月 10GB 存储 + 100 万次 A 类操作免费

### Q: 如何查看部署日志？
A: Workers 详情页 → 日志 → 实时日志

### Q: 配置 Worker URL 时忘记输入 https:// 怎么办？
A: 脚本会自动补全协议，输入 `worker.workers.dev` 即可

### Q: 支持其他 S3 兼容存储吗？
A: 当前版本仅支持 Cloudflare R2。R2 提供 S3 兼容 API，可满足大部分需求。
# NodeSeek/DeepFlood 私信备份脚本

一个用于备份 NodeSeek 和 DeepFlood 私信到 WebDAV 或 Cloudflare R2 的 Tampermonkey 脚本。

## ✨ 功能特性

- 📦 **自动备份**：定期自动备份私信到云端
- 💾 **本地缓存**：IndexedDB 本地存储，离线可访问
- ☁️ **双重备份**：支持同时备份到 WebDAV 和 R2
- 🔄 **一键恢复**：从云端恢复历史私信
- 📝 **备注功能**：为联系人添加备注
- 🗑️ **保留策略**：按数量或天数自动清理旧备份

## 🚀 快速开始

### 1. 安装脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击 [`ns-df-chat-backup.user.js`](ns-df-chat-backup.user.js) 查看脚本
3. 点击 **Raw** 按钮自动安装

### 2. 配置备份

访问 NodeSeek 或 DeepFlood 私信页面：
1. 点击脚本菜单 → **WebDAV 配置**
2. 选择备份方式：
   - **WebDAV**：坚果云、Nextcloud 等
   - **Cloudflare R2**：需要先部署 Worker（见下方）

### 3. 使用功能

- **立即备份**：脚本菜单 → 立即备份
- **查看历史**：脚本菜单 → 历史聊天记录
- **从备份恢复**：历史面板 → 从备份恢复
- **添加备注**：历史面板 → 点击用户名后的 ✏️ 图标

## ☁️ Cloudflare R2 部署（可选）

如果想使用 Cloudflare R2 作为备份存储（推荐），需要先部署 Worker。

详细部署教程请查看：[`workers/README.md`](workers/README.md)

**5 分钟快速部署**：
1. 创建 R2 存储桶
2. 创建 Worker
3. 复制 [`workers/r2-backup-worker-simple.js`](workers/r2-backup-worker-simple.js) 到编辑器
4. 绑定 R2 和配置环境变量

## 📋 备份策略配置

在脚本菜单中可以配置备份保留策略：
- **按数量保留**：如保留最近 30 份备份
- **按天数保留**：如保留最近 30 天的备份

## 🛠️ 技术栈

- **前端脚本**：Tampermonkey Userscript
- **本地存储**：IndexedDB
- **备份后端**：WebDAV / Cloudflare R2
- **Worker 服务**：Cloudflare Workers + R2

## 📝 许可证

MIT License
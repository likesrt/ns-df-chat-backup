# NodeSeek/DeepFlood 私信备份脚本

一个用于备份 NodeSeek 和 DeepFlood 私信到 WebDAV 或 Cloudflare R2 的 Tampermonkey 脚本。

## 功能特性

- 跨站点支持：同时支持 NodeSeek 和 DeepFlood
- 多账号管理：支持多个账号数据分开同步
- 自动备份：定期自动备份私信到云端
- 本地缓存：IndexedDB 本地存储，离线可访问
- 双重备份：支持同时备份到 WebDAV 和 R2
- 一键恢复：从云端恢复历史私信
- 备注功能：为联系人添加备注
- 保留策略：按数量或天数自动清理旧备份

## 预览

|面板|配置|备份列表|
|---|---|---|
|![image](https://cdn.nodeimage.com/i/OfJvczcmuLevcbK3KmEIVSpzSMMvOnY3.png)|![image](https://cdn.nodeimage.com/i/R1QfrRldIGbJbnvM64dbLwarrhl8PJX8.png)|![image](https://cdn.nodeimage.com/i/d6S1gW0R09iC3B35jFDlkIcZidK8xD9F.png)|

## 快速开始

### 1. 安装脚本

1. 首先需要安装一个用户脚本管理器：

- Chrome/Edge: [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) 或 [Greasemonkey](https://addons.mozilla.org/en-US/firefox/addon/greasemonkey/)
- Safari: [Tampermonkey](https://apps.apple.com/us/app/tampermonkey/id1482490089)

2. 点击 [`ns-df-chat-backup.user.js`](ns-df-chat-backup.user.js) 查看脚本

3. 点击 `Raw` 按钮自动安装

4. 或者 [NodeSeek/DeepFlood 私信备份脚本一键直达](https://github.com/likesrt/ns-df-chat-backup/raw/refs/heads/main/ns-df-chat-backup.user.js) 

### 2. 配置备份

访问 NodeSeek 或 DeepFlood 私信页面：
1. 点击脚本菜单 → WebDAV 配置
2. 选择备份方式：
   - WebDAV：坚果云、Nextcloud 等
      1. 点击"历史私信"按钮打开历史记录窗口
      2. 点击"WebDAV设置"按钮
      3. 填写 WebDAV 服务器信息：
         - 服务器地址：如 `https://dav.jianguoyun.com/dav`
         - 用户名：您的 WebDAV 用户名
         - 密码：您的 WebDAV 密码
         - 备份路径：备份文件存储路径，如 `/ns_df_messages_backup/`
   - Cloudflare R2：需要先部署 Worker（见下方）

### 3. 使用功能

- 立即备份：脚本菜单 → 立即备份
- 查看历史：脚本菜单 → 历史聊天记录
- 从备份恢复：历史面板 → 从备份恢复
- 添加备注：历史面板 → 点击用户名后的 图标

## 备份到 Cloudflare R2 （可选）

如果想使用 Cloudflare R2 作为备份存储（推荐），需要先部署 Worker。

详细部署教程请查看：[`workers/README.md`](workers/README.md)

5 分钟快速部署：
1. 创建 R2 存储桶
2. 创建 Worker
3. 复制 [`workers/r2-backup-worker.js`](workers/r2-backup-worker.js) 到编辑器
4. 绑定 R2 和配置环境变量 具体查看 [`workers/README.md`](workers/README.md)

## 备份策略配置

在脚本菜单中可以配置备份保留策略：
- 按数量保留：如保留最近 30 份备份
- 按天数保留：如保留最近 30 天的备份

## 常见问题

### Q: 脚本无法正常工作？
A: 请检查：
- 是否已登录 NodeSeek 账户
- 用户脚本管理器是否正常运行
- 浏览器控制台是否有错误信息

### Q: WebDAV 备份失败？
A: 请检查：
- WebDAV 服务器地址是否正确
- 用户名和密码是否正确
- 备份路径是否存在且有写入权限
- 网络连接是否稳定

### Q: 历史记录显示不全？
A: 可能原因：
- 脚本刚安装，需要时间积累数据
- 本地数据库可能被清理，可尝试从 WebDAV/R2 恢复

## 许可证

MIT License
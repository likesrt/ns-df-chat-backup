// ==UserScript==
// @name         NS-DF 私信备份优化脚本
// @namespace    https://www.nodeseek.com/
// @version      2.0.0
// @description  NS-DF 私信记录本地缓存与 WebDAV R2 备份
// @author       yuyan
// @match        https://www.nodeseek.com/notification*
// @match        https://www.deepflood.com/notification*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      www.nodeseek.com
// @connect      www.deepflood.com
// @connect      dav.jianguoyun.com
// @connect      workers.dev
// @connect      *
// @updateURL    https://github.com/likesrt/ns-df-chat-backup/raw/refs/heads/main/ns-df-chat-backup.user.js
// @downloadURL  https://github.com/likesrt/ns-df-chat-backup/raw/refs/heads/main/ns-df-chat-backup.user.js
// ==/UserScript==

(function () {
  "use strict";

  /**
   * 通用的用户ID获取方法（适用于NS和DF站点）
   * @param {APIClient} api - API客户端实例
   * @param {Object} site - 站点配置对象
   * @returns {Promise<number>} 用户ID
   */
  async function resolveCurrentUserId(api, site) {
    // 方法1: 通过系统通知用户ID推断
    try {
      const systemUserId = site.systemNotificationUserId;
      Utils.debug(`尝试从系统通知会话获取用户ID (系统用户ID: ${systemUserId})...`);
      const probe = await api.request(
        `${api.baseUrl}/notification/message/with/${systemUserId}`
      );
      if (probe?.success && Array.isArray(probe.msgArray)) {
        // 查找包含系统通知用户ID的消息，提取另一方的ID
        for (const msg of probe.msgArray) {
          if (msg.sender_id === systemUserId && Number.isFinite(msg.receiver_id)) {
            Utils.debug(`方法1成功: sender_id=${systemUserId}, 用户ID=${msg.receiver_id}`);
            return msg.receiver_id;
          }
          if (msg.receiver_id === systemUserId && Number.isFinite(msg.sender_id)) {
            Utils.debug(`方法1成功: receiver_id=${systemUserId}, 用户ID=${msg.sender_id}`);
            return msg.sender_id;
          }
        }
      }
      Utils.debug("方法1失败: 未找到有效的系统通知消息");
    } catch (e) {
      Utils.debug(`方法1失败: ${e?.message || e}`);
    }

    // 方法2: 发送测试消息后重试（特殊情况处理）
    try {
      Utils.debug("方法1未获取到用户ID，尝试发送测试消息...");
      const systemUserId = site.systemNotificationUserId;
      const sendResult = await api.sendMessage(systemUserId, "我的用户id", false);
      if (sendResult?.success) {
        Utils.debug("测试消息发送成功，等待500ms后重新尝试获取用户ID...");
        // 等待一小段时间确保消息已写入
        await new Promise(resolve => setTimeout(resolve, 500));

        // 重新请求系统通知会话
        const probe = await api.request(
          `${api.baseUrl}/notification/message/with/${systemUserId}`
        );
        if (probe?.success && Array.isArray(probe.msgArray)) {
          for (const msg of probe.msgArray) {
            if (msg.sender_id === systemUserId && Number.isFinite(msg.receiver_id)) {
              Utils.debug(`方法2成功: sender_id=${systemUserId}, 用户ID=${msg.receiver_id}`);
              return msg.receiver_id;
            }
            if (msg.receiver_id === systemUserId && Number.isFinite(msg.sender_id)) {
              Utils.debug(`方法2成功: receiver_id=${systemUserId}, 用户ID=${msg.sender_id}`);
              return msg.sender_id;
            }
          }
        }
        Utils.debug("方法2失败: 发送测试消息后仍未找到有效数据");
      } else {
        Utils.debug("方法2失败: 测试消息发送失败");
      }
    } catch (e) {
      Utils.debug(`方法2失败: ${e?.message || e}`);
    }

    throw new Error("无法获取用户ID，请确保已登录");
  }

  /**
   * 站点适配注册表
   */
  const SiteRegistry = [
    {
      id: "ns",
      label: "NodeSeek",
      hosts: ["www.nodeseek.com"],
      apiBase: "https://www.nodeseek.com/api",
      referer: "https://www.nodeseek.com/",
      systemNotificationUserId: 5230, // 系统通知用户ID
      avatarUrl: (memberId) => `https://www.nodeseek.com/avatar/${memberId}.png`,
      chatUrl: (memberId) =>
        `https://www.nodeseek.com/notification#/message?mode=talk&to=${memberId}`,
      isMessageListPage: (doc) => {
        const appSwitch = doc.querySelector(".app-switch");
        const messageLink = appSwitch?.querySelector(
          'a[href="#/message?mode=list"]'
        );
        return !!messageLink?.classList.contains("router-link-active");
      },
      resolveCurrentUserId,
    },
    {
      id: "df",
      label: "DeepFlood",
      hosts: ["www.deepflood.com"],
      apiBase: "https://www.deepflood.com/api",
      referer: "https://www.deepflood.com/",
      systemNotificationUserId: 10, // 系统通知用户ID
      avatarUrl: (memberId) => `https://www.deepflood.com/avatar/${memberId}.png`,
      chatUrl: (memberId) =>
        `https://www.deepflood.com/notification#/message?mode=talk&to=${memberId}`,
      isMessageListPage: (doc) => {
        const appSwitch = doc.querySelector(".app-switch");
        const messageLink = appSwitch?.querySelector(
          'a[href="#/message?mode=list"]'
        );
        return !!messageLink?.classList.contains("router-link-active");
      },
      resolveCurrentUserId,
    },
  ];

  function detectActiveSite() {
    const host = window.location.hostname;
    return SiteRegistry.find((s) => s.hosts.includes(host));
  }

  /**
   * 工具函数集合
   */
  const Utils = {
    // Debug开关，设置为 false 可以减少日志输出, true 显示详细日志
    DEBUG: false,

    /**
     * 格式化日期为文件名安全的字符串
     * @param {Date} date - 要格式化的日期对象
     * @returns {string} 格式化后的日期字符串
     */
    formatDate(date) {
      return (
        date.toISOString().replace(/[:.]/g, "-").slice(0, -5) +
        "-" +
        Date.now().toString().slice(-6)
      );
    },

    /**
     * 将UTC时间字符串转换为本地时间字符串
     * @param {string} utcString - UTC时间字符串
     * @returns {string} 本地时间字符串
     */
    parseUTCToLocal(utcString) {
      return new Date(utcString).toLocaleString();
    },

    /**
     * 记录日志信息
     * @param {string} message - 日志消息
     * @param {string} type - 日志类型，默认为'info'
     */
    log(message, type = "info") {
      if (!this.DEBUG && type === "info") return;
      const typeStr = typeof type === "string" ? type.toUpperCase() : "INFO";
      console.log(`[NS-DF私信优化] ${typeStr}: ${message}`);
    },

    /**
     * 记录调试信息（只在DEBUG模式下显示）
     * @param {string} message - 调试消息
     * @param {*} data - 可选的数据对象
     */
    debug(message, data = null) {
      if (!this.DEBUG) return;
      if (data !== null) {
        console.log(`[NS-DF私信优化] DEBUG: ${message}`, data);
      } else {
        console.log(`[NS-DF私信优化] DEBUG: ${message}`);
      }
    },

    /**
     * 记录错误信息
     * @param {string} message - 错误消息
     * @param {Error|null} error - 错误对象，可选
     */
    error(message, error = null) {
      console.error(`[NS-DF私信优化] ERROR: ${message}`, error);
    },

    /**
     * 开启调试模式
     */
    enableDebug() {
      this.DEBUG = true;
      console.log("[NS-DF私信优化] 调试模式已开启");
    },

    /**
     * 关闭调试模式
     */
    disableDebug() {
      this.DEBUG = false;
      console.log("[NS-DF私信优化] 调试模式已关闭");
    },
  };

  /**
   * IndexedDB 数据存储模块
   * 用于本地存储聊天记录数据
   */
  class ChatDB {
    /**
     * 构造函数
     * @param {number} userId - 用户ID
     */
    constructor(userId, site) {
      this.userId = userId;
      this.site = site;
      this.dbName = `${site.id}_chat_${userId}`;
      this.version = 1;
      this.db = null;
    }

    /**
     * 初始化数据库连接
     * @returns {Promise<void>}
     */
    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          if (!db.objectStoreNames.contains("talk_messages")) {
            const store = db.createObjectStore("talk_messages", {
              keyPath: "member_id",
            });
            store.createIndex("created_at", "created_at", { unique: false });
          }

          if (!db.objectStoreNames.contains("metadata")) {
            db.createObjectStore("metadata", { keyPath: "key" });
          }
        };
      });
    }

    /**
     * 保存聊天消息数据
     * @param {Object} memberData - 成员聊天数据
     * @returns {Promise<void>}
     */
    async saveTalkMessage(memberData) {
      const transaction = this.db.transaction(["talk_messages"], "readwrite");
      const store = transaction.objectStore("talk_messages");

      return new Promise((resolve, reject) => {
        const request = store.put(memberData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    /**
     * 获取指定成员的聊天消息
     * @param {number} memberId - 成员ID
     * @returns {Promise<Object|undefined>} 聊天消息数据
     */
    async getTalkMessage(memberId) {
      const transaction = this.db.transaction(["talk_messages"], "readonly");
      const store = transaction.objectStore("talk_messages");

      return new Promise((resolve, reject) => {
        const request = store.get(memberId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    /**
     * 获取所有聊天消息
     * @returns {Promise<Array>} 所有聊天消息数组
     */
    async getAllTalkMessages() {
      const transaction = this.db.transaction(["talk_messages"], "readonly");
      const store = transaction.objectStore("talk_messages");

      return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    /**
     * 更新指定成员的备注
     * @param {number} memberId - 成员ID
     * @param {string} remark - 备注内容
     * @returns {Promise<Object>} 更新后的聊天消息数据
     */
    async updateRemark(memberId, remark) {
      const message = await this.getTalkMessage(memberId);
      if (!message) {
        throw new Error(`未找到成员ID为 ${memberId} 的聊天记录`);
      }
      message.remark = remark || '';
      await this.saveTalkMessage(message);
      return message;
    }

    /**
     * 设置元数据
     * @param {string} key - 键名
     * @param {*} value - 值
     * @returns {Promise<void>}
     */
    async setMetadata(key, value) {
      const transaction = this.db.transaction(["metadata"], "readwrite");
      const store = transaction.objectStore("metadata");

      return new Promise((resolve, reject) => {
        const request = store.put({ key, value });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    /**
     * 获取元数据
     * @param {string} key - 键名
     * @returns {Promise<*>} 元数据值
     */
    async getMetadata(key) {
      const transaction = this.db.transaction(["metadata"], "readonly");
      const store = transaction.objectStore("metadata");

      return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
      });
    }
  }

  /**
   * 站点 API 客户端
   * 用于跨站点统一访问接口
   */
  class APIClient {
    /**
     * @param {object} site - 站点适配器
     */
    constructor(site) {
      this.site = site;
      this.baseUrl = site.apiBase;
      this.referer = site.referer;
    }

    /**
     * 发送HTTP请求
     * @param {string} url - 请求URL
     * @param {Object} options - 请求选项
     * @returns {Promise<Object>} 响应数据
     */
    async request(url, options = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          headers: {
            Accept: "application/json",
            Referer: this.referer,
            ...options.headers,
          },
          onload: (response) => {
            try {
              Utils.debug(`API响应状态: ${response.status}`);
              Utils.debug(
                `API响应内容: ${response.responseText.substring(0, 200)}...`
              );

              if (response.status !== 200) {
                reject(
                  new Error(
                    `HTTP错误: ${response.status} ${response.statusText}`
                  )
                );
                return;
              }

              const data = JSON.parse(response.responseText);
              if (data.status === 404 && data.message === "USER NOT FOUND") {
                reject(new Error("用户未登录"));
                return;
              }
              resolve(data);
            } catch (e) {
              Utils.error(
                `响应解析失败，原始响应: ${response.responseText}`,
                e
              );
              reject(new Error(`响应解析失败: ${e.message}`));
            }
          },
          onerror: (error) => reject(error),
          ontimeout: () => reject(new Error("请求超时")),
        });
      });
    }

    /**
     * 获取当前用户ID
     * @returns {Promise<number>} 用户ID
     */
    async getUserId() {
      try {
        Utils.debug("正在获取用户ID...");
        const userId = await this.site.resolveCurrentUserId(this, this.site);
        Utils.log(`获取到用户ID: ${userId}`);
        return userId;
      } catch (error) {
        Utils.error("获取用户ID失败", error);
        throw error;
      }
    }

    /**
     * 获取与指定用户的聊天消息
     * @param {number} userId - 用户ID
     * @returns {Promise<Object>} 聊天消息数据
     */
    async getChatMessages(userId) {
      const data = await this.request(
        `${this.baseUrl}/notification/message/with/${userId}`
      );
      return data;
    }

    /**
     * 获取消息列表
     * @returns {Promise<Object>} 消息列表数据
     */
    async getMessageList() {
      const data = await this.request(
        `${this.baseUrl}/notification/message/list`
      );
      return data;
    }

    /**
     * 发送消息
     * @param {number} receiverUid - 接收者用户ID
     * @param {string} content - 消息内容
     * @param {boolean} markdown - 是否使用markdown格式
     * @returns {Promise<Object>} 发送结果
     */
    async sendMessage(receiverUid, content, markdown = false) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: `${this.baseUrl}/notification/message/send`,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Referer: this.referer,
          },
          data: JSON.stringify({
            receiverUid: receiverUid,
            content: content,
            markdown: markdown,
          }),
          onload: (response) => {
            try {
              Utils.debug(`发送消息响应状态: ${response.status}`);
              Utils.debug(`发送消息响应: ${response.responseText}`);

              if (response.status !== 200) {
                reject(
                  new Error(
                    `HTTP错误: ${response.status} ${response.statusText}`
                  )
                );
                return;
              }

              const data = JSON.parse(response.responseText);
              resolve(data);
            } catch (e) {
              Utils.error(`发送消息解析失败: ${response.responseText}`, e);
              reject(new Error(`响应解析失败: ${e.message}`));
            }
          },
          onerror: (error) => reject(error),
          ontimeout: () => reject(new Error("请求超时")),
        });
      });
    }
  }

  /**
   * WebDAV 备份模块
   * 用于将聊天记录备份到WebDAV服务器
   */
  class WebDAVBackupProvider {
    /**
     * 构造函数
     * @param {number} userId - 用户ID
     */
    constructor(userId, site) {
      this.userId = userId;
      this.site = site;
      this.configKey = `webdav_config`; // 全局共享配置（所有网站、所有用户通用）
    }

    /**
     * 获取WebDAV配置
     * @returns {Object|null} WebDAV配置对象
     */
    getConfig() {
      const config = GM_getValue(this.configKey, null);
      return config ? JSON.parse(config) : null;
    }

    /**
     * 保存WebDAV配置
     * @param {Object} config - WebDAV配置对象
     */
    saveConfig(config) {
      GM_setValue(this.configKey, JSON.stringify(config));
    }

    /**
     * 构建完整的WebDAV URL
     * @param {string} path - 文件路径
     * @returns {string} 完整的URL
     */
    buildFullUrl(path) {
      const config = this.getConfig();
      if (!config) {
        throw new Error("WebDAV配置未设置");
      }

      Utils.debug(`buildFullUrl 输入参数: path="${path}"`);
      Utils.debug(
        `WebDAV配置: serverUrl="${config.serverUrl}", backupPath="${config.backupPath}"`
      );

      // 如果path已经是完整的URL，直接返回
      if (path.startsWith("http://") || path.startsWith("https://")) {
        Utils.debug(`path是完整URL，直接返回: ${path}`);
        return path;
      }

      const serverBase = config.serverUrl.replace(/\/$/, "");
      Utils.debug(`处理后的serverBase: "${serverBase}"`);

      // 如果path是绝对路径（以/开头），需要检查是否与serverUrl重复
      if (path.startsWith("/")) {
        // 检查serverUrl是否已经包含了path的开头部分
        const serverPath = new URL(serverBase).pathname;
        Utils.debug(`serverUrl的路径部分: "${serverPath}"`);

        // 如果path已经包含了serverUrl的路径部分，避免重复
        if (path.startsWith(serverPath) && serverPath !== "/") {
          const result = `${new URL(serverBase).origin}${path}`;
          Utils.debug(`避免路径重复，拼接结果: ${result}`);
          return result;
        } else {
          const result = `${serverBase}${path}`;
          Utils.debug(`path是绝对路径，拼接结果: ${result}`);
          return result;
        }
      }

      // 如果path是相对路径，需要拼接备份目录
      // 注意：确保不会重复路径部分
      const backupBase = config.backupPath.replace(/^\/+|\/+$/g, ""); // 去除首尾的斜杠
      const fileName = path.replace(/^\/+/, ""); // 去除开头的斜杠

      Utils.debug(`处理后的backupBase: "${backupBase}"`);
      Utils.debug(`处理后的fileName: "${fileName}"`);

      const result = `${serverBase}/${backupBase}/${fileName}`;
      Utils.debug(`最终拼接结果: ${result}`);

      return result;
    }

    async ensureDirectoryExists(directoryPath) {
      const config = this.getConfig();
      if (!config) throw new Error("WebDAV 配置未设置");

      const serverBase = config.serverUrl.replace(/\/$/, "");
      // 规范化路径，逐级创建，确保父级存在
      const normalized = ("/" + directoryPath).replace(/\/+$/, "");
      const segments = normalized.split("/").filter(Boolean);

      let current = "";
      for (const seg of segments) {
        current += "/" + seg;
        const url = `${serverBase}${current}/`;
        // Depth:0 查询该层是否存在
        const exists = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "PROPFIND",
            url,
            headers: {
              Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
              Depth: "0",
            },
            onload: (res) => {
              resolve(res.status >= 200 && res.status < 300);
            },
            onerror: () => resolve(false),
          });
        });

        if (!exists) {
          await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: "MKCOL",
              url,
              headers: {
                Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
              },
              onload: (res) => {
                if (res.status >= 200 && res.status < 300) {
                  Utils.log(`已创建目录: ${current}`);
                  resolve();
                } else {
                  reject(new Error(`创建目录失败: ${res.status} ${res.statusText}`));
                }
              },
              onerror: (err) => reject(new Error(`创建目录网络错误: ${err?.message || "未知错误"}`)),
            });
          });
        }
      }
    }

    async uploadBackup(data, retryCount = 0) {
      const config = this.getConfig();
      if (!config) {
        throw new Error("WebDAV 配置未设置");
      }

      try {
        // 确保站点/用户专属目录存在：<backupPath>/<site>/<userId>
        const userBackupPath = `${config.backupPath.replace(/\/$/, "")}/${this.site.id}/${this.userId}`;
        await this.ensureDirectoryExists(userBackupPath);
      } catch (error) {
        throw new Error(`确保目录存在失败: ${error.message}`);
      }

      const filename = `${this.site.id}_chat_backup_${Utils.formatDate(
        new Date()
      )}.json`;
      const url = `${config.serverUrl.replace(/\/$/, "")}${config.backupPath.replace(/\/$/, "")}/${this.site.id}/${this.userId}/${filename}`;

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "PUT",
          url: url,
          headers: {
            Authorization: `Basic ${btoa(
              `${config.username}:${config.password}`
            )}`,
            "Content-Type": "application/json",
          },
          data: JSON.stringify(data),
          onload: async (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(filename);
            } else if (response.status === 409) {
              if (retryCount < 3) {
                // 409冲突错误，可能是目录不存在或文件冲突，等待一段时间后重试
                Utils.log(
                  `备份冲突 (${response.status})，${
                    1000 * (retryCount + 1)
                  }ms后重试 (${retryCount + 1}/3)`
                );
                setTimeout(async () => {
                  try {
                    const result = await this.uploadBackup(
                      data,
                      retryCount + 1
                    );
                    resolve(result);
                  } catch (error) {
                    reject(error);
                  }
                }, 1000 * (retryCount + 1));
              } else {
                // 重试次数用完，提供更详细的错误信息
                reject(
                  new Error(
                    `备份失败: 目录可能不存在或权限不足 (${response.status})。请检查WebDAV配置和目录权限。`
                  )
                );
              }
            } else {
              const errorMsg = `备份失败: ${response.status} ${response.statusText}`;
              reject(new Error(errorMsg));
            }
          },
          onerror: (error) =>
            reject(
              new Error(`备份上传网络错误: ${error?.message || "未知错误"}`)
            ),
        });
      });
    }

    async listBackups() {
      const config = this.getConfig();
      if (!config) return [];

      // 在用户专属目录下列出备份
      const url = `${config.serverUrl.replace(/\/$/, "")}${config.backupPath.replace(/\/$/, "")}/${this.site.id}/${this.userId}/`;

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "PROPFIND",
          url: url,
          headers: {
            Authorization: `Basic ${btoa(
              `${config.username}:${config.password}`
            )}`,
            Depth: "1",
          },
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              Utils.debug(
                `备份列表响应: ${response.responseText.substring(0, 500)}...`
              );

              // 解析WebDAV响应，提取备份文件列表
              const parser = new DOMParser();
              const doc = parser.parseFromString(
                response.responseText,
                "text/xml"
              );
              const files = Array.from(doc.querySelectorAll("response"))
                .map((response) => {
                  const href = response.querySelector("href")?.textContent;
                  const lastModified =
                    response.querySelector("getlastmodified")?.textContent;

                  Utils.debug(
                    `找到文件: href=${href}, lastModified=${lastModified}`
                  );

                  return { href, lastModified };
                })
                .filter((file) => {
                  const isBackupFile =
                    file.href && file.href.includes(`${this.site.id}_chat_backup_`);
                  Utils.debug(`文件过滤: ${file.href} -> ${isBackupFile}`);
                  return isBackupFile;
                })
                .sort(
                  (a, b) => new Date(b.lastModified) - new Date(a.lastModified)
                );

              Utils.debug(`最终备份文件列表: ${files.length} 个文件`);
              resolve(files);
            } else {
              Utils.debug(
                `获取备份列表失败: ${response.status} - ${response.responseText}`
              );
              reject(new Error(`获取备份列表失败: ${response.status}`));
            }
          },
          onerror: (error) =>
            reject(
              new Error(`获取备份列表网络错误: ${error?.message || "未知错误"}`)
            ),
        });
      });
    }

    /**
     * 清理旧备份文件（根据配置的保留策略）
     * @returns {Promise<void>}
     */
    async cleanOldBackups() {
      try {
        const backups = await this.listBackups();
        if (backups.length === 0) return;

        // 获取保留策略配置
        const retentionType = GM_getValue('retention_type', 'count');
        const retentionCount = GM_getValue('retention_count', 30);
        const retentionDays = GM_getValue('retention_days', 30);

        let toDelete = [];

        if (retentionType === 'count') {
          // 按数量保留：删除超出数量的备份
          if (backups.length > retentionCount) {
            toDelete = backups.slice(retentionCount);
          }
        } else if (retentionType === 'days') {
          // 按天数保留：删除超过指定天数的备份
          const cutoffTime = new Date();
          cutoffTime.setDate(cutoffTime.getDate() - retentionDays);

          toDelete = backups.filter(backup => {
            const backupTime = new Date(backup.lastModified);
            return backupTime < cutoffTime;
          });
        }

        // 执行删除
        if (toDelete.length > 0) {
          const config = this.getConfig();
          for (const backup of toDelete) {
            const deleteUrl = this.buildFullUrl(backup.href);
            await new Promise((resolve, reject) => {
              GM_xmlhttpRequest({
                method: "DELETE",
                url: deleteUrl,
                headers: {
                  Authorization: `Basic ${btoa(
                    `${config.username}:${config.password}`
                  )}`,
                },
                onload: () => resolve(),
                onerror: (error) =>
                  reject(
                    new Error(
                      `删除备份文件网络错误: ${error?.message || "未知错误"}`
                    )
                  ),
              });
            });
          }
          Utils.log(`WebDAV: 已清理 ${toDelete.length} 个旧备份`);
        }
      } catch (error) {
        Utils.error("清理旧备份失败", error);
      }
    }
  }

  /**
   * R2 对象存储（通过 Cloudflare Worker）备份提供者
   * 要求 Worker 暴露如下端点：
   *  - POST /upload  { key: string, data: object }
   *  - GET  /list?prefix=... -> { items: [{ key, lastModified }] }
   *  - GET  /download?key=...  返回对象内容(JSON)
   *  - DELETE /delete?key=...
   */
  class R2WorkerBackupProvider {
    /**
     * @param {number} userId - 用户ID
     * @param {object} site - 站点适配器
     */
    constructor(userId, site) {
      this.userId = userId;
      this.site = site;
      this.configKey = `r2worker_config`; // 全局共享配置（所有网站、所有用户通用）
    }

    getConfig() {
      const config = GM_getValue(this.configKey, null);
      return config ? JSON.parse(config) : null;
    }

    saveConfig(config) {
      GM_setValue(this.configKey, JSON.stringify(config));
    }

    /**
     * 规范化 Worker Base URL（自动补全协议）
     */
    normalizeBaseUrl(url) {
      if (!url) return "";
      let base = url.trim().replace(/\/$/, "");
      if (!/^https?:\/\//i.test(base)) {
        base = `https://${base}`;
      }
      return base;
    }

    buildKey(filename) {
      const cfg = this.getConfig();
      const base = (cfg?.basePath || "/ns_df_messages_backup/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      return `${base}/${this.site.id}/${this.userId}/${filename}`;
    }

    buildFullUrl(key) {
      const cfg = this.getConfig();
      if (!cfg?.workerBaseUrl) throw new Error("R2 Worker 未配置");
      const base = this.normalizeBaseUrl(cfg.workerBaseUrl);
      return `${base}/download?key=${encodeURIComponent(key)}`;
    }

    async uploadBackup(data) {
      const cfg = this.getConfig();
      if (!cfg?.workerBaseUrl || !cfg?.authToken) throw new Error("R2 Worker 未配置");

      const base = this.normalizeBaseUrl(cfg.workerBaseUrl);
      const filename = `${this.site.id}_chat_backup_${Utils.formatDate(new Date())}.json`;
      const key = this.buildKey(filename);

      Utils.log(`[R2 上传] POST ${base}/upload`);
      Utils.log(`[R2 上传] Key: ${key}`);
      Utils.log(`[R2 上传] Data size: ${JSON.stringify(data).length} bytes`);

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: `${base}/upload`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.authToken}`,
          },
          data: JSON.stringify({ key, data }),
          onload: (response) => {
            Utils.log(`[R2 上传响应] Status: ${response.status}`);
            Utils.log(`[R2 上传响应] Body: ${response.responseText}`);

            if (response.status >= 200 && response.status < 300) {
              Utils.log(`[R2 上传] 成功: ${filename}`);
              resolve(filename);
            } else {
              // 尝试解析 JSON 错误响应
              let errorMsg = `R2 上传失败: ${response.status}`;
              try {
                const errorData = JSON.parse(response.responseText);
                if (errorData.message) {
                  errorMsg = `R2 上传失败: ${errorData.message}`;
                } else if (errorData.error) {
                  errorMsg = `R2 上传失败: ${errorData.error}`;
                }
              } catch (e) {
                errorMsg = `R2 上传失败: ${response.status} ${response.statusText}`;
              }
              Utils.error(`[R2 上传] ${errorMsg}`);
              reject(new Error(errorMsg));
            }
          },
          onerror: (error) => {
            Utils.error(`[R2 上传] 网络错误:`, error);
            reject(new Error(`R2 上传网络错误: ${error?.message || "未知错误"}`));
          },
        });
      });
    }

    async listBackups() {
      const cfg = this.getConfig();
      if (!cfg?.workerBaseUrl || !cfg?.authToken) return [];
      const base = this.normalizeBaseUrl(cfg.workerBaseUrl);
      const prefix = this.buildKey("").replace(/\/$/, "");
      const url = `${base}/list?prefix=${encodeURIComponent(prefix)}`;

      Utils.log(`[R2 请求] GET ${url}`);
      Utils.log(`[R2 请求] Prefix: ${prefix}`);

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          headers: {
            Authorization: `Bearer ${cfg.authToken}`,
          },
          onload: (response) => {
            Utils.log(`[R2 响应] Status: ${response.status}`);
            Utils.log(`[R2 响应] Body: ${response.responseText}`);

            if (response.status >= 200 && response.status < 300) {
              try {
                const data = JSON.parse(response.responseText);
                const items = (data.items || []).map((it) => ({
                  href: it.key,
                  lastModified: it.lastModified || new Date().toISOString(),
                }));
                items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
                Utils.log(`[R2 响应] 成功解析 ${items.length} 个备份文件`);
                resolve(items);
              } catch (e) {
                Utils.error(`[R2 响应] 解析失败:`, e);
                reject(new Error(`R2 列表解析失败: ${e.message}`));
              }
            } else {
              // 尝试解析错误信息
              let errorMsg = `R2 获取列表失败: ${response.status}`;
              try {
                const errorData = JSON.parse(response.responseText);
                if (errorData.message) {
                  errorMsg = `R2 获取列表失败: ${errorData.message}`;
                } else if (errorData.error) {
                  errorMsg = `R2 获取列表失败: ${errorData.error}`;
                }
              } catch (e) {
                errorMsg = `R2 获取列表失败: ${response.status} ${response.statusText}`;
              }
              Utils.error(`[R2 响应] ${errorMsg}`);
              reject(new Error(errorMsg));
            }
          },
          onerror: (error) => {
            Utils.error(`[R2 请求] 网络错误:`, error);
            reject(new Error(`R2 获取列表网络错误: ${error?.message || "未知错误"}`));
          },
        });
      });
    }

    /**
     * 清理旧备份文件（根据配置的保留策略）
     * @returns {Promise<void>}
     */
    async cleanOldBackups() {
      try {
        const cfg = this.getConfig();
        if (!cfg?.workerBaseUrl || !cfg?.authToken) return;
        const base = this.normalizeBaseUrl(cfg.workerBaseUrl);
        const backups = await this.listBackups();
        if (backups.length === 0) return;

        // 获取保留策略配置
        const retentionType = GM_getValue('retention_type', 'count');
        const retentionCount = GM_getValue('retention_count', 30);
        const retentionDays = GM_getValue('retention_days', 30);

        let toDelete = [];

        if (retentionType === 'count') {
          // 按数量保留：删除超出数量的备份
          if (backups.length > retentionCount) {
            toDelete = backups.slice(retentionCount);
          }
        } else if (retentionType === 'days') {
          // 按天数保留：删除超过指定天数的备份
          const cutoffTime = new Date();
          cutoffTime.setDate(cutoffTime.getDate() - retentionDays);

          toDelete = backups.filter(backup => {
            const backupTime = new Date(backup.lastModified);
            return backupTime < cutoffTime;
          });
        }

        // 执行删除
        if (toDelete.length > 0) {
          for (const b of toDelete) {
            await new Promise((resolve, reject) => {
              GM_xmlhttpRequest({
                method: "DELETE",
                url: `${base}/delete?key=${encodeURIComponent(b.href)}`,
                headers: {
                  Authorization: `Bearer ${cfg.authToken}`,
                },
                onload: () => resolve(),
                onerror: (error) => reject(new Error(`R2 删除网络错误: ${error?.message || "未知错误"}`)),
              });
            });
          }
          Utils.log(`R2: 已清理 ${toDelete.length} 个旧备份`);
        }
      } catch (e) {
        Utils.error("清理 R2 旧备份失败", e);
      }
    }
  }

  /**
   * UI 管理模块
   * 负责用户界面的创建和管理
   */
  class UIManager {
    /**
     * 构造函数
     */
    constructor(site) {
      this.modals = new Set();
      this.stylesLoaded = false;
      this.talkListObserver = null;
      this.lastTalkListPresent = false;
      this.site = site;
    }

    /**
     * 检测私信页面出现/消失的回调
     * @param {boolean} isPresent - 私信页面是否存在
     */
    onMessagePageChange(isPresent) {
      if (isPresent) {
        Utils.debug("私信页面出现了");
        this.addHistoryButton();
      } else {
        Utils.debug("私信页面消失了");
        this.removeHistoryButton();
      }
    }

    /**
     * 检查私信页面状态
     */
    checkMessagePage() {
      const isMessagePage = this.site.isMessageListPage(document);

      if (isMessagePage !== this.lastTalkListPresent) {
        this.lastTalkListPresent = isMessagePage;
        this.onMessagePageChange(isMessagePage);
      }
    }

    /**
     * 初始化私信页面监听器
     */
    initTalkListObserver() {
      if (this.talkListObserver) {
        this.talkListObserver.disconnect();
      }

      this.talkListObserver = new MutationObserver(() => {
        this.checkMessagePage();
      });

      this.talkListObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });

      // 立即检查一次
      this.checkMessagePage();

      // 再次延迟检查，确保按钮添加成功
      setTimeout(() => this.checkMessagePage(), 100);
      setTimeout(() => this.checkMessagePage(), 500);
    }

    /**
     * 确保样式已加载
     */
    ensureStylesLoaded() {
      if (
        this.stylesLoaded ||
        document.querySelector("#nodeseek-modal-styles")
      ) {
        this.stylesLoaded = true;
        return;
      }

      const styles = document.createElement("style");
      styles.id = "nodeseek-modal-styles";
      styles.textContent = `
                .nodeseek-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 10000;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                .nodeseek-modal-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    box-sizing: border-box;
                }
                .nodeseek-modal-content {
                    background: white;
                    border-radius: 8px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
                    overflow: hidden;
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                }
                .nodeseek-modal-header {
                    padding: 16px 20px;
                    border-bottom: 1px solid #e0e0e0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: #f8f9fa;
                }
                .nodeseek-modal-header h3 {
                    margin: 0;
                    font-size: 18px;
                    color: #333;
                }
                .nodeseek-modal-close {
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #666;
                    padding: 0;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 4px;
                }
                .nodeseek-modal-close:hover {
                    background: #e0e0e0;
                    color: #333;
                }
                .nodeseek-modal-body {
                    padding: 20px;
                    overflow-y: auto;
                    flex: 1;
                }
                .nodeseek-btn {
                    background: #007bff;
                    color: white;
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    margin: 0 4px;
                    transition: background 0.2s;
                }
                .nodeseek-btn:hover {
                    background: #0056b3;
                }
                .nodeseek-btn-secondary {
                    background: #6c757d;
                }
                .nodeseek-btn-secondary:hover {
                    background: #545b62;
                }
                .nodeseek-btn-success {
                    background: #28a745;
                }
                .nodeseek-btn-success:hover {
                    background: #1e7e34;
                }
                .nodeseek-form-group {
                    margin-bottom: 16px;
                }
                .nodeseek-form-group label {
                    display: block;
                    margin-bottom: 4px;
                    font-weight: 500;
                    color: #333;
                }
                .nodeseek-form-group input, .nodeseek-form-group textarea {
                    width: 100%;
                    padding: 8px 12px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 14px;
                    box-sizing: border-box;
                }
                .nodeseek-form-group input:focus, .nodeseek-form-group textarea:focus {
                    outline: none;
                    border-color: #007bff;
                    box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
                }
                .nodeseek-chat-item {
                    display: flex;
                    align-items: center;
                    padding: 12px;
                    border-bottom: 1px solid #e0e0e0;
                    transition: background 0.2s;
                }
                .nodeseek-chat-item:hover {
                    background: #f8f9fa;
                }
                .nodeseek-chat-avatar {
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    margin-right: 12px;
                    object-fit: cover;
                }
                .nodeseek-chat-info {
                    flex: 1;
                    min-width: 0;
                }
                .nodeseek-chat-name {
                    font-weight: 500;
                    color: #333;
                    margin-bottom: 4px;
                }
                .nodeseek-chat-message {
                    color: #666;
                    font-size: 14px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .nodeseek-chat-time {
                    color: #999;
                    font-size: 12px;
                    margin-left: 12px;
                    white-space: nowrap;
                }
                .nodeseek-chat-actions {
                    margin-left: 12px;
                }
                .nodeseek-history-btn {
                    display: inline-block;
                    background: #007bff;
                    color: white;
                    border: none;
                    padding: 8px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    margin-left: 8px;
                    text-decoration: none;
                    vertical-align: middle;
                    transition: all 0.2s;
                    line-height: 1.2;
                }
                .nodeseek-history-btn:hover {
                    background: #0056b3;
                    color: white;
                    text-decoration: none;
                }
            `;
      document.head.appendChild(styles);
      this.stylesLoaded = true;
    }

    /**
     * 创建模态框
     * @param {string} title - 模态框标题
     * @param {string} content - 模态框内容HTML
     * @param {Object} options - 选项配置
     * @returns {HTMLElement} 模态框元素
     */
    createModal(title, content, options = {}) {
      const modal = document.createElement("div");
      modal.className = "nodeseek-modal";
      modal.innerHTML = `
                <div class="nodeseek-modal-overlay">
                    <div class="nodeseek-modal-content" style="max-width: ${
                      options.width || "600px"
                    }; max-height: ${options.height || "80vh"};">
                        <div class="nodeseek-modal-header">
                            <h3>${title}</h3>
                            <button class="nodeseek-modal-close">&times;</button>
                        </div>
                        <div class="nodeseek-modal-body">
                            ${content}
                        </div>
                    </div>
                </div>
            `;

      // 确保样式已加载
      this.ensureStylesLoaded();

      // 事件处理
      const closeBtn = modal.querySelector(".nodeseek-modal-close");
      const overlay = modal.querySelector(".nodeseek-modal-overlay");

      const closeModal = () => {
        modal.remove();
        this.modals.delete(modal);
      };

      closeBtn.addEventListener("click", closeModal);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
      });

      document.body.appendChild(modal);
      this.modals.add(modal);

      return modal;
    }

    /**
     * 显示备份配置对话框（支持 Provider 选择：WebDAV / R2 Worker）
     * @param {Object} backupProvider - 备份提供者实例
     * @param {Function} onSave - 保存回调函数
     */
    showBackupConfig(backupProvider, onSave) {
      const site = this.site;
      const userId = backupProvider.userId;

      // 读取启用状态配置（全局共享）
      const webdavEnabled = GM_getValue(`backup_webdav_enabled`, true);
      const r2Enabled = GM_getValue(`backup_r2_enabled`, false);

      const webdav = new WebDAVBackupProvider(userId, site).getConfig() || {};
      const r2cfg = new R2WorkerBackupProvider(userId, site).getConfig() || {};

      const content = `
        <div style="margin-bottom: 20px; padding: 10px; background: #f0f9ff; border-radius: 4px; border-left: 4px solid #0ea5e9;">
          <strong>💡 提示：</strong>可以同时启用多个备份位置，实现双重备份保护
        </div>

        <!-- WebDAV 配置 -->
        <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <label style="display: flex; align-items: center; font-weight: bold; font-size: 16px;">
              <input type="checkbox" id="webdav-enable" ${webdavEnabled ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px;">
              WebDAV 备份
            </label>
          </div>
          <div id="section-webdav" style="display: ${webdavEnabled ? 'block' : 'none'};">
            <div class="nodeseek-form-group">
              <label>服务器地址</label>
              <input type="url" id="webdav-server" value="${webdav.serverUrl || ''}" placeholder="https://dav.jianguoyun.com/dav/">
            </div>
            <div class="nodeseek-form-group">
              <label>用户名</label>
              <input type="text" id="webdav-username" value="${webdav.username || ''}" placeholder="用户名">
            </div>
            <div class="nodeseek-form-group">
              <label>密码</label>
              <input type="password" id="webdav-password" value="${webdav.password || ''}" placeholder="密码">
            </div>
            <div class="nodeseek-form-group">
              <label>备份路径</label>
              <input type="text" id="webdav-path" value="${webdav.backupPath || '/ns_df_messages_backup/'}" placeholder="/ns_df_messages_backup/">
            </div>
          </div>
        </div>

        <!-- R2 Worker 配置 -->
        <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <label style="display: flex; align-items: center; font-weight: bold; font-size: 16px;">
              <input type="checkbox" id="r2-enable" ${r2Enabled ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px;">
              Cloudflare R2 备份
            </label>
          </div>
          <div id="section-r2worker" style="display: ${r2Enabled ? 'block' : 'none'};">
            <div class="nodeseek-form-group">
              <label>Worker 基址</label>
              <input type="url" id="r2-base" value="${r2cfg.workerBaseUrl || ''}" placeholder="https://your-worker.workers.dev">
            </div>
            <div class="nodeseek-form-group">
              <label>授权 Token（必填）</label>
              <input type="password" id="r2-token" value="${r2cfg.authToken || ''}" placeholder="与 Worker 端 AUTH_TOKEN 一致">
            </div>
            <div class="nodeseek-form-group">
              <label>基础路径</label>
              <input type="text" id="r2-basepath" value="${r2cfg.basePath || '/ns_df_messages_backup/'}" placeholder="/ns_df_messages_backup/">
            </div>
          </div>
        </div>

        <!-- 备份保留策略配置 -->
        <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <div style="font-weight: bold; font-size: 16px; margin-bottom: 12px;">📦 备份保留策略</div>
          <div style="margin-bottom: 12px;">
            <label style="display: flex; align-items: center; margin-bottom: 8px;">
              <input type="radio" name="retention-type" value="count" ${GM_getValue('retention_type', 'count') === 'count' ? 'checked' : ''} style="margin-right: 8px;">
              按数量保留
            </label>
            <div style="margin-left: 24px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                保留最近
                <input type="number" id="retention-count" value="${GM_getValue('retention_count', 30)}" min="1" max="999" style="width: 80px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px;">
                份备份
              </label>
            </div>
          </div>
          <div>
            <label style="display: flex; align-items: center; margin-bottom: 8px;">
              <input type="radio" name="retention-type" value="days" ${GM_getValue('retention_type', 'count') === 'days' ? 'checked' : ''} style="margin-right: 8px;">
              按天数保留
            </label>
            <div style="margin-left: 24px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                保留最近
                <input type="number" id="retention-days" value="${GM_getValue('retention_days', 30)}" min="1" max="365" style="width: 80px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px;">
                天的备份
              </label>
            </div>
          </div>
        </div>

        <div style="text-align: right; margin-top: 20px;">
          <button class="nodeseek-btn nodeseek-btn-secondary" id="backup-cancel">取消</button>
          <button class="nodeseek-btn nodeseek-btn-success" id="backup-save">保存</button>
        </div>
      `;

      const modal = this.createModal("备份设置", content);

      // 切换 WebDAV 显示
      const webdavEnableCheckbox = modal.querySelector('#webdav-enable');
      const secWebdav = modal.querySelector('#section-webdav');
      webdavEnableCheckbox.addEventListener('change', () => {
        secWebdav.style.display = webdavEnableCheckbox.checked ? 'block' : 'none';
      });

      // 切换 R2 显示
      const r2EnableCheckbox = modal.querySelector('#r2-enable');
      const secR2 = modal.querySelector('#section-r2worker');
      r2EnableCheckbox.addEventListener('change', () => {
        secR2.style.display = r2EnableCheckbox.checked ? 'block' : 'none';
      });

      modal.querySelector('#backup-cancel').addEventListener('click', () => modal.remove());
      modal.querySelector('#backup-save').addEventListener('click', () => {
        const webdavChecked = webdavEnableCheckbox.checked;
        const r2Checked = r2EnableCheckbox.checked;

        // 至少要启用一个备份方式
        if (!webdavChecked && !r2Checked) {
          alert('请至少启用一种备份方式');
          return;
        }

        // 保存启用状态（全局共享）
        GM_setValue(`backup_webdav_enabled`, webdavChecked);
        GM_setValue(`backup_r2_enabled`, r2Checked);

        // 保存 WebDAV 配置
        if (webdavChecked) {
          const newConfig = {
            serverUrl: modal.querySelector('#webdav-server').value.trim(),
            username: modal.querySelector('#webdav-username').value.trim(),
            password: modal.querySelector('#webdav-password').value.trim(),
            backupPath: modal.querySelector('#webdav-path').value.trim(),
          };
          if (!newConfig.serverUrl || !newConfig.username || !newConfig.password) {
            alert('请填写完整的WebDAV配置信息');
            return;
          }
          new WebDAVBackupProvider(userId, site).saveConfig(newConfig);
        }

        // 保存 R2 配置
        if (r2Checked) {
          const newConfig = {
            workerBaseUrl: modal.querySelector('#r2-base').value.trim(),
            authToken: modal.querySelector('#r2-token').value.trim(),
            basePath: modal.querySelector('#r2-basepath').value.trim(),
          };
          if (!newConfig.workerBaseUrl) { alert('请填写 R2 Worker 基址'); return; }
          if (!newConfig.authToken) { alert('请填写 R2 Worker 授权 Token'); return; }
          new R2WorkerBackupProvider(userId, site).saveConfig(newConfig);
        }

        // 保存备份保留策略配置
        const retentionType = modal.querySelector('input[name="retention-type"]:checked').value;
        const retentionCount = parseInt(modal.querySelector('#retention-count').value);
        const retentionDays = parseInt(modal.querySelector('#retention-days').value);

        if (retentionType === 'count' && (isNaN(retentionCount) || retentionCount < 1)) {
          alert('请输入有效的保留数量（至少1份）');
          return;
        }
        if (retentionType === 'days' && (isNaN(retentionDays) || retentionDays < 1)) {
          alert('请输入有效的保留天数（至少1天）');
          return;
        }

        GM_setValue('retention_type', retentionType);
        GM_setValue('retention_count', retentionCount);
        GM_setValue('retention_days', retentionDays);

        modal.remove();
        if (onSave) onSave();
      });
    }

    /**
     * 显示历史聊天记录
     * @param {Array} chatData - 聊天数据数组
     * @param {boolean} showLatest - 是否显示最新聊天，默认false
     * @param {number} userId - 当前用户ID
     * @returns {HTMLElement} 模态框元素
     */
    showHistoryChats(chatData, showLatest = false, userId = null) {
      const sortedChats = chatData
        .filter((chat) => showLatest || !chat.isLatest)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      // 构建标题，包含用户ID
      const titleText = userId ? `历史私信 (用户ID: ${userId})` : '历史私信';

      let content = `
                <div style="margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="nodeseek-btn" id="backup-config-btn">备份设置</button>
                    <button class="nodeseek-btn nodeseek-btn-success" id="backup-now-btn">立即备份</button>
                    <button class="nodeseek-btn nodeseek-btn-secondary" id="restore-btn">从备份恢复</button>
                    <label style="display: flex; align-items: center; margin-left: auto;">
                        <input type="checkbox" id="show-latest-toggle" ${
                          showLatest ? "checked" : ""
                        } style="margin-right: 4px;">
                        显示最新聊天
                    </label>
                </div>
                <div style="max-height: 400px; overflow-y: auto;">
            `;

      if (sortedChats.length === 0) {
        content +=
          '<div style="text-align: center; color: #666; padding: 40px;">暂无历史聊天记录</div>';
      } else {
        sortedChats.forEach((chat) => {
            const avatarUrl = this.site.avatarUrl(chat.member_id);
            const chatUrl = this.site.chatUrl(chat.member_id);
          const timeStr = Utils.parseUTCToLocal(chat.created_at);

          // 构建备注显示
          const remarkText = chat.remark ? ` (备注: ${chat.remark})` : '';

          content += `
                        <div class="nodeseek-chat-item">
                            <img class="nodeseek-chat-avatar" src="${avatarUrl}" alt="${
            chat.member_name
          }" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMjAiIGZpbGw9IiNlMGUwZTAiLz4KPHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4PSI4IiB5PSI4Ij4KPHBhdGggZD0iTTEyIDEyQzE0LjIwOTEgMTIgMTYgMTAuMjA5MSAxNiA4QzE2IDUuNzkwODYgMTQuMjA5MSA0IDEyIDRDOS43OTA4NiA0IDggNS43OTA4NiA4IDhDOCAxMC4yMDkxIDkuNzkwODYgMTIgMTIgMTJaIiBmaWxsPSIjOTk5Ii8+CjxwYXRoIGQ9Ik0xMiAxNEM5LjMzIDEzLjk5IDcuMDEgMTUuNjIgNiAxOEMxMC4wMSAyMCAxMy45OSAyMCAxOCAxOEMxNi45OSAxNS42MiAxNC42NyAxMy45OSAxMiAxNFoiIGZpbGw9IiM5OTkiLz4KPC9zdmc+Cjwvc3ZnPgo='">
                            <div class="nodeseek-chat-info">
                                <div class="nodeseek-chat-name">
                                    ${chat.member_name} (ID: ${chat.member_id})${remarkText}
                                    <button class="nodeseek-remark-btn" data-member-id="${chat.member_id}" data-member-name="${chat.member_name}" data-remark="${chat.remark || ''}" title="编辑备注" style="margin-left: 8px; cursor: pointer; background: none; border: none; font-size: 14px; padding: 2px 6px; border-radius: 4px; transition: background 0.2s;">✏️</button>
                                </div>
                                <div class="nodeseek-chat-message">${chat.content
                                  .replace(/<[^>]*>/g, "")
                                  .substring(0, 50)}${
            chat.content.length > 50 ? "..." : ""
          }</div>
                            </div>
                            <div class="nodeseek-chat-time">${timeStr}</div>
                            <div class="nodeseek-chat-actions">
                                <a href="${chatUrl}" target="_blank" class="nodeseek-btn" style="text-decoration: none; font-size: 12px; padding: 4px 8px;">打开对话</a>
                            </div>
                        </div>
                    `;
        });
      }

      content += "</div>";

      return this.createModal(titleText, content, {
        width: "800px",
        height: "600px",
      });
    }

    /**
     * 添加历史聊天按钮
     */
    addHistoryButton() {
      this.ensureStylesLoaded();

      const existingBtn = document.querySelector(".nodeseek-history-btn");
      if (existingBtn) return; // 按钮已存在，无需重复添加

      const appSwitch = document.querySelector(".app-switch");
      const messageLink = appSwitch?.querySelector(
        'a[href="#/message?mode=list"]'
      );

      if (!appSwitch || !messageLink) {
        Utils.debug("app-switch 或私信链接元素不存在，将稍后重试");
        return;
      }

      const btn = document.createElement("a");
      btn.className = "nodeseek-history-btn";
      btn.textContent = "历史私信";
      btn.href = "javascript:void(0)";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        window.chatBackup?.showHistoryChats();
      });

      // 将按钮插入到私信链接后面
      messageLink.insertAdjacentElement("afterend", btn);
      Utils.debug("历史聊天按钮已添加到私信链接后面");
    }

    /**
     * 移除历史聊天按钮
     */
    removeHistoryButton() {
      const btn = document.querySelector(".nodeseek-history-btn");
      if (btn) btn.remove();
    }

    /**
     * 显示提示消息
     * @param {string} message - 提示消息内容
     * @param {string} type - 消息类型：'success', 'error', 'warning', 'info'
     * @param {number} duration - 显示持续时间（毫秒），默认3000
     */
    showToast(message, type = "success", duration = 3000) {
      // 移除已存在的提示
      const existingToast = document.querySelector(".nodeseek-toast");
      if (existingToast) existingToast.remove();

      const toast = document.createElement("div");
      toast.className = "nodeseek-toast";

      const bgColor =
        type === "success"
          ? "#28a745"
          : type === "error"
          ? "#dc3545"
          : type === "warning"
          ? "#ffc107"
          : "#007bff";

      toast.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: ${bgColor};
                color: white;
                padding: 12px 20px;
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                z-index: 10001;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 300px;
                word-wrap: break-word;
                opacity: 0;
                transform: translateX(100%);
                transition: all 0.3s ease;
            `;

      toast.textContent = message;
      document.body.appendChild(toast);

      // 显示动画
      setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateX(0)";
      }, 10);

      // 自动消失
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        setTimeout(() => {
          if (toast.parentNode) {
            toast.remove();
          }
        }, 300);
      }, duration);
    }

    /**
     * 显示自定义输入框（限制 10 个中文字符）
     * @param {string} title - 标题
     * @param {string} defaultValue - 默认值
     * @param {string} placeholder - 占位文本
     * @returns {Promise<string|null>} - 返回用户输入或 null（取消）
     */
    showInputDialog(title, defaultValue = "", placeholder = "") {
      return new Promise((resolve) => {
        // 创建遮罩层
        const overlay = document.createElement("div");
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        `;

        // 创建对话框
        const dialog = document.createElement("div");
        dialog.style.cssText = `
          background: white;
          border-radius: 8px;
          padding: 20px;
          min-width: 320px;
          max-width: 400px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
          transform: scale(0.9);
          transition: transform 0.2s;
        `;

        // 标题
        const titleEl = document.createElement("div");
        titleEl.style.cssText = `
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 16px;
          color: #333;
        `;
        titleEl.textContent = title;

        // 输入框
        const input = document.createElement("input");
        input.type = "text";
        input.value = defaultValue;
        input.placeholder = placeholder;
        input.maxLength = 10; // 限制 10 个字符
        input.style.cssText = `
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          box-sizing: border-box;
          outline: none;
        `;

        // 字符计数
        const counter = document.createElement("div");
        counter.style.cssText = `
          text-align: right;
          font-size: 12px;
          color: #999;
          margin-top: 4px;
        `;
        counter.textContent = `${input.value.length}/10`;

        // 更新字符计数
        input.addEventListener("input", () => {
          counter.textContent = `${input.value.length}/10`;
          if (input.value.length >= 10) {
            counter.style.color = "#dc3545";
          } else {
            counter.style.color = "#999";
          }
        });

        // 按钮容器
        const buttons = document.createElement("div");
        buttons.style.cssText = `
          display: flex;
          gap: 10px;
          margin-top: 16px;
          justify-content: flex-end;
        `;

        // 取消按钮
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.style.cssText = `
          padding: 8px 16px;
          border: 1px solid #ddd;
          background: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        `;
        cancelBtn.addEventListener("click", () => {
          closeDialog(null);
        });

        // 确定按钮
        const confirmBtn = document.createElement("button");
        confirmBtn.textContent = "确定";
        confirmBtn.style.cssText = `
          padding: 8px 16px;
          border: none;
          background: #007bff;
          color: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        `;
        confirmBtn.addEventListener("click", () => {
          closeDialog(input.value);
        });

        // 组装元素
        buttons.appendChild(cancelBtn);
        buttons.appendChild(confirmBtn);
        dialog.appendChild(titleEl);
        dialog.appendChild(input);
        dialog.appendChild(counter);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 关闭对话框函数
        const closeDialog = (value) => {
          overlay.style.opacity = "0";
          dialog.style.transform = "scale(0.9)";
          setTimeout(() => {
            overlay.remove();
            resolve(value);
          }, 200);
        };

        // 显示动画
        setTimeout(() => {
          overlay.style.opacity = "1";
          dialog.style.transform = "scale(1)";
        }, 10);

        // 自动聚焦并全选
        setTimeout(() => {
          input.focus();
          input.select();
        }, 250);

        // 支持 Enter 确认和 Esc 取消
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            closeDialog(input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeDialog(null);
          }
        });

        // 点击遮罩层关闭
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) {
            closeDialog(null);
          }
        });
      });
    }
  }

  /**
   * 主控制模块
   * 负责协调各个模块的工作
   */
  class ChatBackup {
    /**
     * 构造函数
     */
    constructor(site) {
      this.site = site;
      this.api = new APIClient(site);
      this.db = null;
      this.backup = null;
      this.ui = new UIManager(site);
      this.userId = null;
      this.backupTimer = null;
      this.lastHash = "";
      this.showLatestChats = false;
    }

    /**
     * 初始化应用
     * @returns {Promise<void>}
     */
    async init() {
      try {
        Utils.debug("开始初始化脚本...");

        // 检查是否在支持的站点
        if (!this.site) {
          Utils.debug("不在支持站点，跳过初始化");
          return;
        }

        // 获取用户ID
        this.userId = await this.api.getUserId();
        // 读取站点/用户专属的显示偏好
        this.showLatestChats = GM_getValue(
          `show_latest_chats_${this.site.id}_${this.userId}`,
          false
        );

        // 立即初始化 UI（不等待数据库和备份）
        this.ui.initTalkListObserver();
        Utils.debug("UI 初始化完成，历史私信按钮已添加");

        // 初始化数据库和WebDAV
        this.db = new ChatDB(this.userId, this.site);
        await this.db.init();

      // 初始化备份提供者（默认 webdav，可在"备份设置"中切换）
      const providerType = GM_getValue("backup_provider_type", "webdav");
      this.backup = providerType === "r2worker"
        ? new R2WorkerBackupProvider(this.userId, this.site)
        : new WebDAVBackupProvider(this.userId, this.site);

        // 打开页面后自动备份一次（静默忽略未配置等错误）
        try {
          await this.performBackup();
        } catch (e) {
          Utils.debug(`初始自动备份跳过: ${e?.message || e}`);
        }
        this._didInitialAutoBackup = true;

        // 监听页面变化
        this.setupPageListener();

        // 注册菜单命令
        this.registerMenuCommands();

        // 处理当前页面
        this.handlePageChange();

        Utils.log("NS-DF私信优化脚本初始化完成");
      } catch (error) {
        Utils.error("初始化失败", error);
        // 显示用户友好的错误提示
        if (error.message.includes("用户未登录")) {
          console.warn("[NS-DF私信优化] 请先登录账户");
        } else if (error.message.includes("响应解析失败")) {
          console.warn(
            "[NS-DF私信优化] 网络请求失败，请检查网络连接或稍后重试"
          );
        } else {
          console.warn("[NS-DF私信优化] 初始化失败，请刷新页面重试");
        }
      }
    }

    // 定时自动备份已移除：改为页面打开与数据变更时触发备份

    /**
     * 设置页面监听器
     */
    setupPageListener() {
      window.addEventListener("hashchange", () => {
        this.handlePageChange();
      });

      const observer = new MutationObserver(() => {
        if (window.location.hash !== this.lastHash) {
          this.lastHash = window.location.hash;
          this.handlePageChange();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    /**
     * 处理页面变化
     * @returns {Promise<void>}
     */
    async handlePageChange() {
      const hash = window.location.hash;
      this.lastHash = hash;

      try {
        if (hash.includes("mode=talk&to=")) {
          const match = hash.match(/to=(\d+)/);
          if (match) {
            const targetUserId = parseInt(match[1]);
            await this.handleChatPage(targetUserId);
          }
        } else if (hash.includes("mode=list")) {
          await this.handleMessageListPage();
        }
      } catch (error) {
        Utils.error("页面处理失败", error);
      }
    }

    /**
     * 处理聊天页面
     * @param {number} targetUserId - 目标用户ID
     * @returns {Promise<void>}
     */
    async handleChatPage(targetUserId) {
      try {
        const response = await this.api.getChatMessages(targetUserId);
        if (
          response.success &&
          response.msgArray &&
          response.msgArray.length > 0
        ) {
          const latestMessage = response.msgArray[response.msgArray.length - 1];
          const talkTo = response.talkTo;

          const chatData = {
            member_id: talkTo.member_id,
            member_name: talkTo.member_name,
            content: latestMessage.content,
            created_at: latestMessage.created_at,
            sender_id: latestMessage.sender_id,
            receiver_id: latestMessage.receiver_id,
            message_id: latestMessage.id,
            viewed: latestMessage.viewed,
            updated_at: new Date().toISOString(),
          };

          // 检查是否需要更新
          const existingData = await this.db.getTalkMessage(talkTo.member_id);
          if (
            !existingData ||
            existingData.created_at !== latestMessage.created_at
          ) {
            await this.db.saveTalkMessage(chatData);
            Utils.log(`更新聊天记录: ${talkTo.member_name}`);
            this.performBackup();
          }
        }
      } catch (error) {
        if (error.message === "用户未登录") {
          Utils.log("用户未登录，停止操作");
          return;
        }
        Utils.error("处理聊天页面失败", error);
      }
    }

    /**
     * 处理消息列表页面
     * @returns {Promise<void>}
     */
    async handleMessageListPage() {
      try {
        const response = await this.api.getMessageList();
        if (response.success && response.msgArray) {
          let hasUpdates = false;
          const currentChatUserIds = new Set();

          for (const msg of response.msgArray) {
            // 判断聊天对象
            let chatUserId, chatUserName;
            if (msg.sender_id === this.userId) {
              chatUserId = msg.receiver_id;
              chatUserName = msg.receiver_name;
            } else {
              chatUserId = msg.sender_id;
              chatUserName = msg.sender_name;
            }

            currentChatUserIds.add(chatUserId);

            const chatData = {
              member_id: chatUserId,
              member_name: chatUserName,
              content: msg.content,
              created_at: msg.created_at,
              sender_id: msg.sender_id,
              receiver_id: msg.receiver_id,
              message_id: msg.max_id,
              viewed: msg.viewed,
              updated_at: new Date().toISOString(),
              isLatest: true,
            };

            // 检查是否需要更新
            const existingData = await this.db.getTalkMessage(chatUserId);
            if (!existingData || existingData.created_at !== msg.created_at) {
              await this.db.saveTalkMessage(chatData);
              hasUpdates = true;
            }
          }

          // 更新其他聊天记录的isLatest标记
          const allChats = await this.db.getAllTalkMessages();
          for (const chat of allChats) {
            if (!currentChatUserIds.has(chat.member_id) && chat.isLatest) {
              chat.isLatest = false;
              await this.db.saveTalkMessage(chat);
            }
          }

          if (hasUpdates) {
            // 数据变更后立即自动备份
            try { await this.performBackup(); } catch (e) { Utils.debug(`自动备份跳过: ${e?.message || e}`); }
          }
        }

        // 打开消息列表页时自动备份一次（即使无变更）
        if (!this._didInitialAutoBackup) {
          try { await this.performBackup(); } catch (e) { Utils.debug(`初始页面备份跳过: ${e?.message || e}`); }
          this._didInitialAutoBackup = true;
        }
      } catch (error) {
        if (error.message === "用户未登录") {
          Utils.log("用户未登录，停止操作");
          return;
        }
        Utils.error("处理消息列表页面失败", error);
      }
    }

    /**
     * 执行备份（支持同时备份到多个位置）
     * @returns {Promise<void>}
     */
    async performBackup() {
      try {
        // 获取启用状态
        const webdavEnabled = GM_getValue(`backup_webdav_enabled`, true);
        const r2Enabled = GM_getValue(`backup_r2_enabled`, false);

        if (!webdavEnabled && !r2Enabled) {
          Utils.log("未启用任何备份方式，跳过备份");
          throw new Error("未配置任何备份方式");
        }

        // 准备备份数据
        const allChats = await this.db.getAllTalkMessages();

        // 收集用户配置数据
        const webdavProvider = new WebDAVBackupProvider(this.userId, this.site);
        const r2Provider = new R2WorkerBackupProvider(this.userId, this.site);

        const userConfig = {
          // 备份启用状态
          backup: {
            webdav_enabled: GM_getValue(`backup_webdav_enabled`, true),
            r2_enabled: GM_getValue(`backup_r2_enabled`, false),
          },
          // 保留策略
          retention: {
            type: GM_getValue('retention_type', 'count'),
            count: GM_getValue('retention_count', 30),
            days: GM_getValue('retention_days', 30),
          },
          // WebDAV 配置
          webdav: webdavProvider.getConfig() || null,
          // R2 配置
          r2: r2Provider.getConfig() || null,
        };

        const metadata = {
          userId: this.userId,
          siteId: this.site,
          backupTime: new Date().toISOString(),
          totalChats: allChats.length,
          version: '2.0.0', // 备份格式版本
        };

        const backupData = {
          metadata,
          config: userConfig,
          chats: allChats,
        };

        const results = [];
        const errors = [];

        // 并行备份到多个位置
        const backupPromises = [];

        if (webdavEnabled) {
          const webdavProvider = new WebDAVBackupProvider(this.userId, this.site);
          const webdavConfig = webdavProvider.getConfig();
          if (webdavConfig && webdavConfig.serverUrl) {
            backupPromises.push(
              webdavProvider.uploadBackup(backupData)
                .then(async (filename) => {
                  await webdavProvider.cleanOldBackups();
                  results.push(`WebDAV: ${filename}`);
                  Utils.log(`WebDAV备份完成: ${filename}`);
                })
                .catch((err) => {
                  errors.push(`WebDAV失败: ${err.message}`);
                  Utils.error("WebDAV备份失败", err);
                })
            );
          } else {
            Utils.log("WebDAV已启用但未配置，跳过");
          }
        }

        if (r2Enabled) {
          const r2Provider = new R2WorkerBackupProvider(this.userId, this.site);
          const r2Config = r2Provider.getConfig();
          if (r2Config && r2Config.workerBaseUrl) {
            backupPromises.push(
              r2Provider.uploadBackup(backupData)
                .then(async (filename) => {
                  await r2Provider.cleanOldBackups();
                  results.push(`R2: ${filename}`);
                  Utils.log(`R2备份完成: ${filename}`);
                })
                .catch((err) => {
                  errors.push(`R2失败: ${err.message}`);
                  Utils.error("R2备份失败", err);
                })
            );
          } else {
            Utils.log("R2已启用但未配置，跳过");
          }
        }

        // 检查是否有实际配置的备份方式
        if (backupPromises.length === 0) {
          throw new Error("未配置任何备份服务器，请先在备份设置中配置");
        }

        // 等待所有备份完成
        await Promise.all(backupPromises);

        // 更新最后备份时间
        if (results.length > 0) {
          GM_setValue(`last_backup_${this.site.id}_${this.userId}`, Date.now());
          Utils.log(`备份完成: ${results.join(', ')}`);
        }

        // 如果所有备份都失败，抛出错误
        if (errors.length > 0 && results.length === 0) {
          throw new Error(`所有备份均失败: ${errors.join('; ')}`);
        }

        // 如果部分成功，记录警告并返回部分成功信息
        if (errors.length > 0) {
          const warningMsg = `备份部分成功\n✓ 成功: ${results.join(', ')}\n✗ 失败: ${errors.join('; ')}`;
          Utils.log(warningMsg);
          return { partial: true, message: warningMsg };
        }

        return { partial: false };
      } catch (error) {
        Utils.error("备份失败", error);
        throw error;
      }
    }

    /**
     * 清空所有聊天数据
     * @returns {Promise<void>}
     */
    async clearAllChatData() {
      try {
        const transaction = this.db.db.transaction(
          ["talk_messages"],
          "readwrite"
        );
        const store = transaction.objectStore("talk_messages");

        return new Promise((resolve, reject) => {
          const request = store.clear();
          request.onsuccess = () => {
            Utils.debug("所有聊天记录已清空");
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        Utils.error("清空聊天数据失败", error);
        throw error;
      }
    }

    /**
     * 显示历史聊天记录
     * @returns {Promise<void>}
     */
    async showHistoryChats() {
      try {
        const allChats = await this.db.getAllTalkMessages();
        const modal = this.ui.showHistoryChats(allChats, this.showLatestChats, this.userId);

        // 绑定事件
        modal
          .querySelector("#backup-config-btn")
          .addEventListener("click", () => {
            this.ui.showBackupConfig(this.backup, () => {
              const providerType = GM_getValue(
                "backup_provider_type",
                "webdav"
              );
              this.backup = providerType === "r2worker"
                ? new R2WorkerBackupProvider(this.userId, this.site)
                : new WebDAVBackupProvider(this.userId, this.site);
              Utils.log("备份配置已保存");
              this.ui.showToast("备份配置已保存");
              this.performBackup();
            });
          });

        modal
          .querySelector("#backup-now-btn")
          .addEventListener("click", async () => {
            try {
              const result = await this.performBackup();
              if (result && result.partial) {
                this.ui.showToast(result.message, "warning");
              } else {
                this.ui.showToast("备份完成");
              }
            } catch (error) {
              this.ui.showToast("备份失败: " + error.message, "error");
            }
          });

        modal.querySelector("#restore-btn").addEventListener("click", () => {
          this.showRestoreOptions();
        });

        modal
          .querySelector("#show-latest-toggle")
          .addEventListener("change", async (e) => {
            this.showLatestChats = e.target.checked;
            GM_setValue(
              `show_latest_chats_${this.site.id}_${this.userId}`,
              this.showLatestChats
            );
            this.ui.showToast(
              e.target.checked ? "已显示最新聊天" : "已隐藏最新聊天"
            );

            // 重新渲染聊天列表而不关闭模态框
            const allChats = await this.db.getAllTalkMessages();
            const chatListContainer = modal.querySelector('.nodeseek-modal-body > div:last-child');
            if (chatListContainer) {
              // 过滤和排序聊天
              const sortedChats = allChats
                .filter((chat) => this.showLatestChats || !chat.isLatest)
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

              // 生成新的聊天列表 HTML
              let newContent = '';
              if (sortedChats.length === 0) {
                newContent = '<div style="text-align: center; color: #666; padding: 40px;">暂无历史聊天记录</div>';
              } else {
                sortedChats.forEach((chat) => {
                  const avatarUrl = this.site.avatarUrl(chat.member_id);
                  const chatUrl = this.site.chatUrl(chat.member_id);
                  const timeStr = Utils.parseUTCToLocal(chat.created_at);
                  const remarkText = chat.remark ? ` (备注: ${chat.remark})` : '';

                  newContent += `
                    <div class="nodeseek-chat-item">
                      <img class="nodeseek-chat-avatar" src="${avatarUrl}" alt="${chat.member_name}" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMjAiIGZpbGw9IiNlMGUwZTAiLz4KPHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4PSI4IiB5PSI4Ij4KPHBhdGggZD0iTTEyIDEyQzE0LjIwOTEgMTIgMTYgMTAuMjA5MSAxNiA4QzE2IDUuNzkwODYgMTQuMjA5MSA0IDEyIDRDOS43OTA4NiA0IDggNS43OTA4NiA4IDhDOCAxMC4yMDkxIDkuNzkwODYgMTIgMTIgMTJaIiBmaWxsPSIjOTk5Ii8+CjxwYXRoIGQ9Ik0xMiAxNEM5LjMzIDEzLjk5IDcuMDEgMTUuNjIgNiAxOEMxMC4wMSAyMCAxMy45OSAyMCAxOCAxOEMxNi45OSAxNS42MiAxNC42NyAxMy45OSAxMiAxNFoiIGZpbGw9IiM5OTkiLz4KPC9zdmc+Cjwvc3ZnPgo='">
                      <div class="nodeseek-chat-info">
                        <div class="nodeseek-chat-name">
                          ${chat.member_name} (ID: ${chat.member_id})${remarkText}
                          <button class="nodeseek-remark-btn" data-member-id="${chat.member_id}" data-member-name="${chat.member_name}" data-remark="${chat.remark || ''}" title="编辑备注" style="margin-left: 8px; cursor: pointer; background: none; border: none; font-size: 14px; padding: 2px 6px; border-radius: 4px; transition: background 0.2s;">✏️</button>
                        </div>
                        <div class="nodeseek-chat-message">${chat.content.replace(/<[^>]*>/g, "").substring(0, 50)}${chat.content.length > 50 ? "..." : ""}</div>
                      </div>
                      <div class="nodeseek-chat-time">${timeStr}</div>
                      <div class="nodeseek-chat-actions">
                        <a href="${chatUrl}" target="_blank" class="nodeseek-btn" style="text-decoration: none; font-size: 12px; padding: 4px 8px;">打开对话</a>
                      </div>
                    </div>
                  `;
                });
              }

              // 更新容器内容
              chatListContainer.innerHTML = newContent;

              // 重新绑定备注编辑按钮事件
              chatListContainer.querySelectorAll(".nodeseek-remark-btn").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                  e.preventDefault();
                  const memberId = parseInt(btn.getAttribute("data-member-id"));
                  const memberName = btn.getAttribute("data-member-name");
                  const currentRemark = btn.getAttribute("data-remark");

                  const newRemark = await this.ui.showInputDialog(
                    `编辑 ${memberName} 的备注`,
                    currentRemark,
                    "留空可删除备注"
                  );

                  if (newRemark === null) return;

                  try {
                    // 先更新界面显示
                    btn.setAttribute("data-remark", newRemark.trim());
                    const nameElement = btn.closest(".nodeseek-chat-name");
                    const remarkText = newRemark.trim() ? ` (备注: ${newRemark.trim()})` : '';
                    const memberNameText = nameElement.childNodes[0].textContent.split(' (')[0];
                    nameElement.childNodes[0].textContent = `${memberNameText} (ID: ${memberId})${remarkText}`;

                    this.ui.showToast("备注已更新,正在同步...");

                    // 后台更新数据库和备份
                    this.db.updateRemark(memberId, newRemark.trim())
                      .then(() => this.performBackup())
                      .then(() => {
                        Utils.log("备注已同步到数据库和备份");
                      })
                      .catch((error) => {
                        Utils.error("后台同步备注失败", error);
                        this.ui.showToast("备注同步失败: " + error.message, "error");
                      });
                  } catch (error) {
                    this.ui.showToast("更新备注失败: " + error.message, "error");
                    Utils.error("更新备注失败", error);
                  }
                });
              });
            }
          });

        // 绑定备注编辑按钮事件
        modal.querySelectorAll(".nodeseek-remark-btn").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.preventDefault();
            const memberId = parseInt(btn.getAttribute("data-member-id"));
            const memberName = btn.getAttribute("data-member-name");
            const currentRemark = btn.getAttribute("data-remark");

            // 使用自定义输入框获取新备注
            const newRemark = await this.ui.showInputDialog(
              `编辑 ${memberName} 的备注`,
              currentRemark,
              "留空可删除备注"
            );

            // 用户点击取消则不操作
            if (newRemark === null) return;

            try {
              // 先更新界面显示
              btn.setAttribute("data-remark", newRemark.trim());

              // 找到并更新名称显示
              const chatItem = btn.closest(".nodeseek-chat-item");
              const nameDiv = chatItem.querySelector(".nodeseek-chat-name");
              const remarkText = newRemark.trim() ? ` (备注: ${newRemark.trim()})` : '';
              const memberNameText = `${memberName} (ID: ${memberId})${remarkText}`;

              // 保留编辑按钮,只更新文本部分
              nameDiv.innerHTML = `${memberNameText}<button class="nodeseek-remark-btn" data-member-id="${memberId}" data-member-name="${memberName}" data-remark="${newRemark.trim()}" title="编辑备注" style="margin-left: 8px; cursor: pointer; background: none; border: none; font-size: 14px; padding: 2px 6px; border-radius: 4px; transition: background 0.2s;">✏️</button>`;

              this.ui.showToast("备注已更新,正在同步...");

              // 后台更新数据库和备份
              this.db.updateRemark(memberId, newRemark.trim())
                .then(() => this.performBackup())
                .then(() => {
                  Utils.log("备注已同步到数据库和备份");
                })
                .catch((error) => {
                  Utils.error("后台同步备注失败", error);
                  this.ui.showToast("备注同步失败: " + error.message, "error");
                });
            } catch (error) {
              this.ui.showToast("更新备注失败: " + error.message, "error");
              Utils.error("更新备注失败", error);
            }
          });
        });
      } catch (error) {
        Utils.error("显示历史聊天失败", error);
      }
    }

    /**
     * 显示恢复选项（支持选择备份来源）
     * @returns {Promise<void>}
     */
    async showRestoreOptions() {
      try {
        // 获取启用状态
        const webdavEnabled = GM_getValue(`backup_webdav_enabled`, true);
        const r2Enabled = GM_getValue(`backup_r2_enabled`, false);

        // 显示来源选择界面
        let sourceContent = `
          <div style="margin-bottom: 20px; padding: 12px; background: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 4px;">
            <strong>💡 提示：</strong>请选择要从哪个位置恢复备份
          </div>
          <div style="display: flex; gap: 12px; justify-content: center;">
        `;

        if (webdavEnabled) {
          sourceContent += `
            <button class="nodeseek-btn nodeseek-btn-success" id="restore-from-webdav" style="flex: 1; padding: 20px;">
              <div style="font-size: 18px; margin-bottom: 8px;">📁</div>
              <div style="font-weight: bold;">WebDAV</div>
              <div style="font-size: 12px; opacity: 0.8;">从 WebDAV 恢复</div>
            </button>
          `;
        }

        if (r2Enabled) {
          sourceContent += `
            <button class="nodeseek-btn nodeseek-btn-success" id="restore-from-r2" style="flex: 1; padding: 20px;">
              <div style="font-size: 18px; margin-bottom: 8px;">☁️</div>
              <div style="font-weight: bold;">Cloudflare R2</div>
              <div style="font-size: 12px; opacity: 0.8;">从 R2 恢复</div>
            </button>
          `;
        }

        sourceContent += "</div>";

        const sourceModal = this.ui.createModal("选择备份来源", sourceContent, { width: "500px" });

        // WebDAV 恢复
        sourceModal.querySelector('#restore-from-webdav')?.addEventListener('click', async () => {
          sourceModal.remove();
          await this.showRestoreListFromProvider(new WebDAVBackupProvider(this.userId, this.site), "WebDAV");
        });

        // R2 恢复
        sourceModal.querySelector('#restore-from-r2')?.addEventListener('click', async () => {
          sourceModal.remove();
          await this.showRestoreListFromProvider(new R2WorkerBackupProvider(this.userId, this.site), "R2");
        });

      } catch (error) {
        Utils.error("显示恢复选项失败", error);
        this.ui.showToast("获取恢复选项失败: " + error.message, "error");
      }
    }

    /**
     * 从指定提供者显示备份列表
     * @param {Object} provider - 备份提供者实例
     * @param {string} providerName - 提供者名称
     * @returns {Promise<void>}
     */
    async showRestoreListFromProvider(provider, providerName) {
      try {
        Utils.debug(`正在从 ${providerName} 获取备份列表...`);
        const backups = await provider.listBackups();

        if (backups.length === 0) {
          this.ui.showToast(`${providerName} 没有找到备份文件`, "warning");
          return;
        }

        Utils.debug(`从 ${providerName} 找到 ${backups.length} 个备份文件`);

        let content = `
                    <div style="margin-bottom: 16px; padding: 12px; background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 4px; font-size: 14px;">
                        <strong>⚠️ 重要提示：</strong>恢复操作会<strong>完全覆盖</strong>现有的本地聊天数据，原有数据将被删除且无法恢复！
                    </div>
                    <div style="margin-bottom: 12px; padding: 8px; background: #f0f9ff; border-radius: 4px; text-align: center;">
                        <strong>备份来源：${providerName}</strong>
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                `;

        backups.forEach((backup, index) => {
          const date = new Date(backup.lastModified).toLocaleString();
          const fileName = backup.href.split("/").pop();
          content += `
                        <div style="padding: 12px; border-bottom: 1px solid #eee; cursor: pointer; transition: background 0.2s;"
                             data-backup="${backup.href}"
                             data-provider="${providerName}"
                             onmouseover="this.style.background='#f8f9fa'"
                             onmouseout="this.style.background='transparent'">
                            <div style="font-weight: 500; margin-bottom: 4px;">备份 ${
                              index + 1
                            }</div>
                            <div style="font-size: 12px; color: #666; margin-bottom: 2px;">时间: ${date}</div>
                            <div style="font-size: 11px; color: #999;">文件: ${fileName}</div>
                        </div>
                    `;
        });
        content += "</div>";

        const modal = this.ui.createModal("选择要恢复的备份", content, {
          width: "500px",
        });

        modal.querySelectorAll("[data-backup]").forEach((item) => {
          item.addEventListener("click", async () => {
            const backupHref = item.dataset.backup;
            const providerType = item.dataset.provider;
            if (
              confirm(
                `确定要从 ${providerType} 恢复此备份吗？\n\n⚠️ 此操作将完全覆盖本地数据，无法撤销！`
              )
            ) {
              modal.remove();
              try {
                this.ui.showToast(`正在从 ${providerType} 恢复备份...`, "info");
                await this.restoreFromBackup(backupHref, provider);
                this.ui.showToast("恢复成功！页面将自动刷新", "success");
                setTimeout(() => location.reload(), 1500);
              } catch (error) {
                Utils.error("恢复失败", error);
                this.ui.showToast("恢复失败: " + error.message, "error");
              }
            }
          });
        });
      } catch (error) {
        Utils.error(`从 ${providerName} 获取备份列表失败`, error);
        this.ui.showToast(`获取 ${providerName} 备份列表失败: ` + error.message, "error");
      }
    }

    /**
     * 从备份恢复数据
     * @param {string} backupPath - 备份文件路径
     * @param {Object} provider - 备份提供者实例
     * @returns {Promise<void>}
     */
    async restoreFromBackup(backupPath, provider) {
      try {
        const config = provider.getConfig();
        if (!config) {
          throw new Error("备份提供者未配置");
        }

        // 构建正确的URL
        const url = provider.buildFullUrl(backupPath);
        Utils.debug(`正在从以下URL恢复备份: ${url}`);

        const response = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "GET",
            url: url,
            headers: {
              ...(provider instanceof WebDAVBackupProvider
                ? { Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}` }
                : {}),
              ...(provider instanceof R2WorkerBackupProvider && config.authToken
                ? { Authorization: `Bearer ${config.authToken}` }
                : {}),
              Accept: "application/json",
            },
            onload: (response) => {
              Utils.debug(`恢复请求响应状态: ${response.status}`);
              Utils.debug(`恢复请求响应头: ${response.responseHeaders}`);

              if (response.status >= 200 && response.status < 300) {
                try {
                  const data = JSON.parse(response.responseText);
                  resolve(data);
                } catch (parseError) {
                  Utils.error(`解析备份文件失败: ${parseError.message}`);
                  Utils.debug(
                    `原始响应内容: ${response.responseText.substring(0, 500)}`
                  );
                  reject(new Error(`备份文件格式错误: ${parseError.message}`));
                }
              } else {
                let errorMessage = `HTTP错误 ${response.status}`;

                // 针对不同的HTTP状态码提供更具体的错误信息
                switch (response.status) {
                  case 401:
                    errorMessage = "认证失败，请检查WebDAV用户名和密码";
                    break;
                  case 403:
                    errorMessage = "权限不足，无法访问备份文件";
                    break;
                  case 404:
                    errorMessage = "备份文件不存在或已被删除";
                    break;
                  case 409:
                    errorMessage = "文件访问冲突，请稍后重试";
                    break;
                  case 500:
                    errorMessage = "WebDAV服务器内部错误";
                    break;
                  default:
                    errorMessage = `服务器返回错误: ${response.status} ${response.statusText}`;
                }

                Utils.debug(`详细错误信息: ${response.responseText}`);
                reject(new Error(errorMessage));
              }
            },
            onerror: (error) => {
              Utils.error("网络请求失败", error);
              reject(new Error("网络连接失败，请检查网络连接"));
            },
            ontimeout: () => {
              reject(new Error("请求超时，请稍后重试"));
            },
            timeout: 30000, // 30秒超时
          });
        });

        if (response && response.chats && Array.isArray(response.chats)) {
          Utils.debug(`开始恢复 ${response.chats.length} 条聊天记录`);

          // 完全覆盖模式：先清空现有数据
          Utils.debug("清空现有聊天记录...");
          await this.clearAllChatData();

          let successCount = 0;
          for (const chat of response.chats) {
            try {
              // 规范化聊天数据,确保包含所有必需字段
              const normalizedChat = {
                member_id: chat.member_id,
                member_name: chat.member_name || '未知用户',
                content: chat.content || '',
                created_at: chat.created_at || new Date().toISOString(),
                sender_id: chat.sender_id || 0,
                receiver_id: chat.receiver_id || 0,
                message_id: chat.message_id || chat.id || 0,
                viewed: chat.viewed ?? false,
                updated_at: chat.updated_at || new Date().toISOString(),
                isLatest: chat.isLatest ?? false,
                remark: chat.remark || '',  // 保留备注信息
              };

              await this.db.saveTalkMessage(normalizedChat);
              successCount++;
            } catch (dbError) {
              Utils.error(`保存聊天记录失败 (ID: ${chat.member_id})`, dbError);
            }
          }

          // 恢复配置数据（如果备份中包含）
          if (response.config) {
            Utils.debug("开始恢复配置数据...");
            try {
              // 恢复备份启用状态
              if (response.config.backup) {
                GM_setValue(`backup_webdav_enabled`, response.config.backup.webdav_enabled ?? true);
                GM_setValue(`backup_r2_enabled`, response.config.backup.r2_enabled ?? false);
                Utils.debug("备份启用状态已恢复");
              }

              // 恢复保留策略
              if (response.config.retention) {
                GM_setValue('retention_type', response.config.retention.type || 'count');
                GM_setValue('retention_count', response.config.retention.count || 30);
                GM_setValue('retention_days', response.config.retention.days || 30);
                Utils.debug("保留策略已恢复");
              }

              // 恢复 WebDAV 配置
              if (response.config.webdav && response.config.webdav.serverUrl) {
                GM_setValue(`webdav_config`, JSON.stringify(response.config.webdav));
                Utils.debug("WebDAV 配置已恢复");
              }

              // 恢复 R2 配置
              if (response.config.r2 && response.config.r2.workerBaseUrl) {
                GM_setValue(`r2worker_config`, JSON.stringify(response.config.r2));
                Utils.debug("R2 配置已恢复");
              }

              Utils.log("配置数据恢复完成");
            } catch (configError) {
              Utils.error("恢复配置数据时出错", configError);
              // 配置恢复失败不影响整体恢复流程
            }
          }

          const message = `恢复完成，已覆盖本地数据，共恢复 ${successCount} 条聊天记录${response.config ? ' 和配置信息' : ''}`;
          Utils.log(message);
          this.ui.showToast(message);
        } else {
          throw new Error("备份文件格式不正确或不包含聊天数据");
        }
      } catch (error) {
        Utils.error("恢复备份失败", error);

        // 显示用户友好的错误提示
        let userMessage = error.message;
        if (error.message.includes("409") || error.message.includes("冲突")) {
          userMessage =
            "文件访问冲突，请稍后重试。如果问题持续存在，请检查WebDAV服务器状态。";
        }

        this.ui.showToast(`恢复失败: ${userMessage}`, "error", 5000);
      }
    }

    /**
     * 注册菜单命令
     */
    registerMenuCommands() {
      GM_registerMenuCommand("备份设置", () => {
        this.ui.showBackupConfig(this.backup, () => {
          const providerType = GM_getValue(
            "backup_provider_type",
            "webdav"
          );
          this.backup = providerType === "r2worker"
            ? new R2WorkerBackupProvider(this.userId, this.site)
            : new WebDAVBackupProvider(this.userId, this.site);
          Utils.log("备份配置已保存");
          this.ui.showToast("备份配置已保存");
          this.performBackup();
        });
      });

      GM_registerMenuCommand("立即备份", async () => {
        try {
          const result = await this.performBackup();
          if (result && result.partial) {
            this.ui.showToast(result.message, "warning");
          } else {
            this.ui.showToast("备份完成");
          }
        } catch (error) {
          this.ui.showToast("备份失败: " + error.message, "error");
        }
      });

      GM_registerMenuCommand("历史聊天记录", () => {
        this.showHistoryChats();
      });
    }
  }

  /**
   * 全局变量
   */
  let chatBackup;

  /**
   * 初始化脚本
   */
  function initScript() {
    try {
      Utils.debug("脚本开始加载...");

      const activeSite = detectActiveSite();
      if (!activeSite) {
        Utils.debug("不在支持站点，脚本不会运行");
        return;
      }

      chatBackup = new ChatBackup(activeSite);
      window.chatBackup = chatBackup;

      if (document.readyState === "loading") {
        Utils.debug("等待DOM加载完成...");
        document.addEventListener("DOMContentLoaded", () => {
          Utils.debug("DOM加载完成，1秒后开始初始化");
          setTimeout(() => chatBackup.init(), 100);
        });
      } else {
        Utils.debug("DOM已加载，1秒后开始初始化");
        setTimeout(() => chatBackup.init(), 100);
      }
    } catch (error) {
      Utils.error("脚本初始化失败", error);
    }
  }

  /**
   * 启动脚本
   */
  initScript();
})();

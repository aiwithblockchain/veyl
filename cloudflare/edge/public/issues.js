(function () {
  "use strict";

  var API = "/v1/issues";
  var view = document.getElementById("view");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function platformName(value) {
    if (value === "macos") return "macOS";
    if (value === "windows") return "Windows";
    if (value === "linux") return "Linux";
    return value || "未知平台";
  }

  function versionLine(item) {
    var parts = [];
    if (item.platform) parts.push(platformName(item.platform));
    if (item.app_version) parts.push(item.app_version);
    if (item.os_version) parts.push(item.os_version);
    return parts.join(" · ");
  }

  function formatTime(value) {
    if (value == null || value === "") return "";
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function normalizeList(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.issues)) return payload.issues;
    if (payload.data) {
      if (Array.isArray(payload.data.issues)) return payload.data.issues;
      if (Array.isArray(payload.data)) return payload.data;
    }
    return [];
  }

  function normalizeThread(payload) {
    if (!payload || typeof payload !== "object") return null;
    var root = payload.data && typeof payload.data === "object" ? payload.data : payload;
    var issue = root.issue && typeof root.issue === "object" ? root.issue : root;
    if (!issue || (!issue.id && !issue.title)) return null;
    var replies = root.replies || issue.replies || [];
    return { issue: issue, replies: Array.isArray(replies) ? replies : [] };
  }

  function renderMessage(message, withRetry) {
    view.textContent = "";
    var box = el("div", "state");
    box.appendChild(el("p", null, message));
    if (withRetry) {
      var button = el("button", "state__retry", "重试");
      button.type = "button";
      button.addEventListener("click", route);
      box.appendChild(button);
    }
    view.appendChild(box);
  }

  function replyBadge(item) {
    var answered = Number(item.reply_count || 0) > 0;
    var badge = el("span", "badge" + (answered ? " badge--answered" : ""), answered ? "已回复" : "待回复");
    return badge;
  }

  function issueCard(item) {
    var card = el("li", "issue-card");

    var top = el("div", "issue-card__top");
    var heading = el("h2", "issue-card__title");
    var link = el("a", null, item.title || "未命名问题");
    link.href = "issues.html?id=" + encodeURIComponent(item.id || "");
    heading.appendChild(link);
    top.appendChild(heading);
    top.appendChild(replyBadge(item));
    card.appendChild(top);

    if (item.summary) card.appendChild(el("p", "issue-card__summary", item.summary));

    var meta = el("div", "issue-card__meta");
    if (item.email_masked) meta.appendChild(el("span", null, item.email_masked));
    var version = versionLine(item);
    if (version) meta.appendChild(el("span", null, version));
    var time = formatTime(item.last_activity_at || item.created_at);
    if (time) meta.appendChild(el("span", null, time));
    var count = Number(item.reply_count || 0);
    meta.appendChild(el("span", null, count > 0 ? count + " 条答复" : "暂无答复"));
    card.appendChild(meta);

    return card;
  }

  function renderList(items) {
    view.textContent = "";

    var head = el("div", "page-head");
    head.appendChild(el("h1", null, "问题墙"));
    head.appendChild(el("p", null, "用户上报的问题与运营答复，按最近活跃排序。"));
    view.appendChild(head);

    if (!items.length) {
      view.appendChild(el("p", "state", "还没有人上报问题。"));
      return;
    }

    var list = el("ul", "issue-list");
    items.forEach(function (item) {
      if (item && typeof item === "object") list.appendChild(issueCard(item));
    });
    view.appendChild(list);
  }

  function addSection(parent, label, text) {
    if (!text) return;
    var section = el("section", "thread__section");
    section.appendChild(el("h2", null, label));
    section.appendChild(el("p", null, text));
    parent.appendChild(section);
  }

  function renderThread(thread) {
    var issue = thread.issue;
    view.textContent = "";

    var back = el("a", "thread__back", "← 返回问题墙");
    back.href = "issues.html";
    view.appendChild(back);

    var article = el("article", "thread");
    article.appendChild(el("h1", null, issue.title || "未命名问题"));

    var meta = el("div", "thread__meta");
    if (issue.email_masked) meta.appendChild(el("span", null, issue.email_masked));
    var created = formatTime(issue.created_at);
    if (created) meta.appendChild(el("span", null, "发布于 " + created));
    var active = formatTime(issue.last_activity_at);
    if (active && active !== created) meta.appendChild(el("span", null, "最后活跃 " + active));
    article.appendChild(meta);

    if (issue.summary) article.appendChild(el("p", "thread__summary", issue.summary));
    addSection(article, "期望", issue.expected);
    addSection(article, "实际", issue.actual);
    addSection(article, "复现", issue.repro);

    var environment = [];
    if (issue.platform) environment.push(platformName(issue.platform));
    if (issue.app_version) environment.push("客户端 " + issue.app_version);
    if (issue.os_version) environment.push("系统 " + issue.os_version);
    if (environment.length) addSection(article, "环境", environment.join(" · "));

    var replies = el("section", "replies");
    replies.appendChild(el("h2", null, "运营答复"));
    if (!thread.replies.length) {
      replies.appendChild(el("p", "state", "运营还没有回复。"));
    } else {
      thread.replies.forEach(function (reply) {
        var box = el("div", "reply");
        var head = el("div", "reply__head");
        head.appendChild(el("span", null, reply.author === "admin" ? "Veyl 运营" : "用户"));
        var time = formatTime(reply.created_at);
        if (time) head.appendChild(el("span", null, time));
        box.appendChild(head);
        box.appendChild(el("p", "reply__body", reply.body || ""));
        replies.appendChild(box);
      });
    }
    article.appendChild(replies);

    view.appendChild(article);
  }

  function loadList() {
    renderMessage("正在读取…", false);
    fetch(API, { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (response.status === 404) {
          renderMessage("问题墙暂时没有内容。", true);
          return null;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data == null) return;
        renderList(normalizeList(data));
      })
      .catch(function () {
        renderMessage("暂时读不到问题墙，请稍后再试。", true);
      });
  }

  function loadThread(id) {
    renderMessage("正在读取…", false);
    fetch(API + "/" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (response.status === 404) {
          renderMessage("这个问题不存在或已撤下。", false);
          return null;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data == null) return;
        var thread = normalizeThread(data);
        if (!thread) {
          renderMessage("这个问题不存在或已撤下。", false);
          return;
        }
        renderThread(thread);
      })
      .catch(function () {
        renderMessage("暂时读不到这条问题，请稍后再试。", true);
      });
  }

  function route() {
    var id = new URLSearchParams(window.location.search).get("id");
    if (id) loadThread(id);
    else loadList();
  }

  route();
})();

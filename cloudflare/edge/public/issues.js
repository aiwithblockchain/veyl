(function () {
  "use strict";

  var API = "/v1/issues";
  var LANG = (document.documentElement.lang || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  var STRINGS = {
    zh: {
      listTitle: "问题墙",
      listIntro: "用户上报的问题与运营答复，按最近活跃排序。",
      emptyList: "还没有人上报问题。",
      unanswered: "待回复",
      answered: "已回复",
      noReplies: "暂无答复",
      replyCount: function (n) { return n + " 条答复"; },
      untitled: "未命名问题",
      unknownPlatform: "未知平台",
      loading: "正在读取…",
      retry: "重试",
      apiEmpty: "问题墙暂时没有内容。",
      listFailed: "暂时读不到问题墙，请稍后再试。",
      notFound: "这个问题不存在或已撤下。",
      threadFailed: "暂时读不到这条问题，请稍后再试。",
      back: "← 返回问题墙",
      posted: "发布于 ",
      lastActive: "最后活跃 ",
      expected: "期望",
      actual: "实际",
      repro: "复现",
      environment: "环境",
      client: "客户端 ",
      os: "系统 ",
      repliesTitle: "运营答复",
      noResponses: "运营还没有回复。",
      admin: "Veyl 运营",
      user: "用户",
      timeLocale: "zh-CN"
    },
    en: {
      listTitle: "Issues",
      listIntro: "Questions reported by users and our responses, sorted by recent activity.",
      emptyList: "No issues have been reported yet.",
      unanswered: "Awaiting reply",
      answered: "Answered",
      noReplies: "No replies",
      replyCount: function (n) { return n === 1 ? "1 reply" : n + " replies"; },
      untitled: "Untitled issue",
      unknownPlatform: "Unknown platform",
      loading: "Loading…",
      retry: "Retry",
      apiEmpty: "The issues wall has no content for now.",
      listFailed: "Could not load the issues wall. Please try again later.",
      notFound: "This issue does not exist or has been removed.",
      threadFailed: "Could not load this issue. Please try again later.",
      back: "← Back to issues",
      posted: "Posted ",
      lastActive: "Last active ",
      expected: "Expected",
      actual: "Actual",
      repro: "Steps to reproduce",
      environment: "Environment",
      client: "Client ",
      os: "OS ",
      repliesTitle: "Responses",
      noResponses: "No responses yet.",
      admin: "Veyl team",
      user: "User",
      timeLocale: "en-US"
    }
  };
  var T = STRINGS[LANG];
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
    return value || T.unknownPlatform;
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
      return new Intl.DateTimeFormat(T.timeLocale, {
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
      var button = el("button", "state__retry", T.retry);
      button.type = "button";
      button.addEventListener("click", route);
      box.appendChild(button);
    }
    view.appendChild(box);
  }

  function replyBadge(item) {
    var answered = Number(item.reply_count || 0) > 0;
    var badge = el("span", "badge" + (answered ? " badge--answered" : ""), answered ? T.answered : T.unanswered);
    return badge;
  }

  function issueCard(item) {
    var card = el("li", "issue-card");

    var top = el("div", "issue-card__top");
    var heading = el("h2", "issue-card__title");
    var link = el("a", null, item.title || T.untitled);
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
    meta.appendChild(el("span", null, count > 0 ? T.replyCount(count) : T.noReplies));
    card.appendChild(meta);

    return card;
  }

  function renderList(items) {
    view.textContent = "";

    var head = el("div", "page-head");
    head.appendChild(el("h1", null, T.listTitle));
    head.appendChild(el("p", null, T.listIntro));
    view.appendChild(head);

    if (!items.length) {
      view.appendChild(el("p", "state", T.emptyList));
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

    var back = el("a", "thread__back", T.back);
    back.href = "issues.html";
    view.appendChild(back);

    var article = el("article", "thread");
    article.appendChild(el("h1", null, issue.title || T.untitled));

    var meta = el("div", "thread__meta");
    if (issue.email_masked) meta.appendChild(el("span", null, issue.email_masked));
    var created = formatTime(issue.created_at);
    if (created) meta.appendChild(el("span", null, T.posted + created));
    var active = formatTime(issue.last_activity_at);
    if (active && active !== created) meta.appendChild(el("span", null, T.lastActive + active));
    article.appendChild(meta);

    if (issue.summary) article.appendChild(el("p", "thread__summary", issue.summary));
    addSection(article, T.expected, issue.expected);
    addSection(article, T.actual, issue.actual);
    addSection(article, T.repro, issue.repro);

    var environment = [];
    if (issue.platform) environment.push(platformName(issue.platform));
    if (issue.app_version) environment.push(T.client + issue.app_version);
    if (issue.os_version) environment.push(T.os + issue.os_version);
    if (environment.length) addSection(article, T.environment, environment.join(" · "));

    var replies = el("section", "replies");
    replies.appendChild(el("h2", null, T.repliesTitle));
    if (!thread.replies.length) {
      replies.appendChild(el("p", "state", T.noResponses));
    } else {
      thread.replies.forEach(function (reply) {
        var box = el("div", "reply");
        var head = el("div", "reply__head");
        head.appendChild(el("span", null, reply.author === "admin" ? T.admin : T.user));
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
    renderMessage(T.loading, false);
    fetch(API, { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (response.status === 404) {
          renderMessage(T.apiEmpty, true);
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
        renderMessage(T.listFailed, true);
      });
  }

  function loadThread(id) {
    renderMessage(T.loading, false);
    fetch(API + "/" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (response.status === 404) {
          renderMessage(T.notFound, false);
          return null;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data == null) return;
        var thread = normalizeThread(data);
        if (!thread) {
          renderMessage(T.notFound, false);
          return;
        }
        renderThread(thread);
      })
      .catch(function () {
        renderMessage(T.threadFailed, true);
      });
  }

  function route() {
    var id = new URLSearchParams(window.location.search).get("id");
    if (id) loadThread(id);
    else loadList();
  }

  route();
})();

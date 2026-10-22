'use strict';
/**
 * test/helpers/fixtures.js —— 与真实结构同构的最小夹具
 *
 * 设计原则（参考 HugoAura test/ 的风格）：
 *   夹具只复刻「我们依赖的那部分真实行为」，且逐字标注它对应 main.js 的哪一段。
 *   不 require electron，不读真实 bundle，因此测试可在纯 Node 下运行。
 *
 * 真实依据：
 *   - 屏保控制器 main.js @159264
 *   - 窗口管理器 newWindow main.js @76173
 *   - 任务常量 module 38 @40739
 */

/** 构造一个「官方屏保控制器」同构体：记录它做了什么，便于断言 */
function makeController() {
  const calls = { shared: [], enqueued: [], outQueue: [], newWindow: [], closed: [] };
  const controller = {
    calls,
    /**
     * 逐字复刻官方 onMessage 的行为骨架（main.js @159264）：
     *   e.url === "/displayScreenSaver" && (
     *     share("screensaverTransitionList", 随机数组(长度=imageList.length)),
     *     share("screensaverMessage", e.data),
     *     enQueue({ taskName: "SCREENSAVER", taskDependencies: ["LIVE","SCHOOLANNOUNCEMENT"], ... })
     *   )
     */
    onMessage(e) {
      if (e.url !== '/displayScreenSaver') return;
      const imageList = (e.data && e.data.imageList) || [];
      const transition = [];
      for (let s = 0; s < imageList.length; s++) {
        transition.push(Math.floor(Math.random() * 7)); // 官方 t 默认 7 → 0..6
      }
      calls.shared.push({ name: 'screensaverTransitionList', data: transition });
      calls.shared.push({ name: 'screensaverMessage', data: e.data });
      calls.enqueued.push({
        taskName: 'SCREENSAVER',
        taskDependencies: ['LIVE', 'SCHOOLANNOUNCEMENT'],
        startTask: 'startScreensaver',
        pauseTask: 'closeWindow',
        coutinueTask: 'startScreensaver', // 官方拼写错误，原样保留
        closedTask: 'stopScreensaver',
      });
    },
    startScreensaver() { calls.newWindow.push('screensaver'); },
    stopScreensaver() { calls.outQueue.push('SCREENSAVER'); },
  };
  return controller;
}

/** 可记录的 share 总线桩（对齐 main.js module 2 的 share(name, data, windowName?)） */
function makeShareStub() {
  const calls = [];
  return {
    calls,
    share(name, data, windowName) { calls.push({ name, data, windowName }); },
    find(name) { return calls.filter((c) => c.name === name); },
    get(name) {
      const hits = calls.filter((c) => c.name === name);
      return hits.length ? hits[hits.length - 1].data : undefined;
    },
  };
}

/** 可记录的任务队列桩（对齐 module 39 的 enQueue/outQueue，官方原拼写） */
function makeQueueStub() {
  const tasks = [];
  return {
    tasks,
    enQueue(t) { tasks.push(t); },
    outQueue(name) {
      const i = tasks.findIndex((t) => t && t.taskName === name);
      if (i >= 0) tasks.splice(i, 1);
    },
  };
}

/**
 * 构造「官方窗口管理器」同构体（main.js @76173 + @76,9xx resetWindow）。
 *
 * 复刻要点：
 *   r.on("close", () => { setTimeout(() => { this.closeWindow(); this.startLock(); }, 0) })
 *   —— close 回调里 **同步**记录 startLock 调用（真实是 setTimeout，测试里同步更易断言，
 *      但我们保留「回调里调用 startLock」这一语义核心）。
 */
function makeWindowManager() {
  const calls = { newWindow: [], resetWindow: [], startLock: 0, closeWindow: [] };
  const createdWindows = [];

  /** 官方窗口工厂 s.addOne(type, name) */
  function addOne(type, name) {
    const handlers = {};
    const win = {
      type,
      name,
      handlers,
      __closed: false,
      setBounds() {},
      show() {},
      isDestroyed() { return this.__closed; },
      close() { this.__closed = true; },
      on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); },
      emit(event) { (handlers[event] || []).forEach((cb) => cb()); },
    };
    createdWindows.push(win);
    return win;
  }

  const wm = {
    calls,
    createdWindows,
    addOne, // 真实里来自 module 3，挂在这里以便守卫包装
    windowsList: {},

    /** 逐字复刻官方 newWindow */
    newWindow(e, t) {
      calls.newWindow.push(e);
      const displays = [{ bounds: { width: 1920, height: 1080, x: 0, y: 0 } }];
      for (let i = 0; i < displays.length; i++) {
        const wname = e + '_' + i;
        if (this.windowsList[e] && this.windowsList[e].includes(wname)) continue;
        const win = this.addOne(e, wname);
        this.windowsList[e] = this.windowsList[e] || [];
        this.windowsList[e].push(wname);
        win.setBounds(displays[i].bounds);
        win.show();
        // ★ 官方级联回调原文
        win.on('close', () => {
          this.closeWindow(e);
          this.startLock();
        });
      }
    },

    resetWindow(e) {
      calls.resetWindow.push(e);
      const wname = e + '_0';
      const win = this.addOne(e, wname);
      win.on('close', () => {
        this.closeWindow(e);
        this.startLock();
      });
      win.show();
    },

    /** 官方 this.startLock（真正属于锁屏控制器；这里作为级联目标桩） */
    startLock() { calls.startLock++; },

    closeWindow(e) { calls.closeWindow.push(e); },
  };
  return wm;
}

/** 构造 ConfigManager 替身：getConfig() 返回给定配置 */
function makeConfigManager(config) {
  let current = config;
  return {
    getConfig() { return current; },
    set(c) { current = c; },
  };
}

module.exports = {
  makeController,
  makeShareStub,
  makeQueueStub,
  makeWindowManager,
  makeConfigManager,
};

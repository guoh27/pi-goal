你当前所在仓库是：

https://github.com/guoh27/pi-goal

这是本项目的目标仓库。请直接修改当前仓库，不要创建另一个独立项目。

需要参考并合并我的另一个 fork：

https://github.com/guoh27/pi-retry

上游分别是：

- pi-goal: Michaelliv/pi-goal
- pi-retry: monotykamary/pi-retry

目标不是简单复制两个 extension，而是把 pi-retry 的 retry/recovery 能力真正整合进 pi-goal，使整个插件只有一个 autonomous-turn lifecycle owner。

最终用户只需要安装：

    guoh27/pi-goal

不再需要单独安装：

    guoh27/pi-retry

==================================================
一、总体目标
==================================================

将 pi-retry 的能力完整合并到 pi-goal，使 pi-goal 默认同时提供：

1. Persistent autonomous goal
2. Provider error retry
3. Network/connection error retry
4. HTTP 400/413 retry
5. credit/payment transient retry
6. max_tokens / stopReason=length 自动 continuation
7. empty/thinking-only stop 的一次性 recovery nudge
8. /retry 手动控制和诊断能力
9. retry lifecycle events
10. background-work-aware Goal continuation

最重要的设计原则：

    Retry 和 Goal continuation 必须由同一个 coordinator 管理。

严禁出现：

    pi-retry -> sendMessage(triggerTurn=true)
    pi-goal  -> sendMessage(triggerTurn=true)

两套互相不知道状态的 continuation loop。

整个插件在任意时刻只能有一个 autonomous next-turn owner。

==================================================
二、保持 pi-retry 原有能力
==================================================

研究 guoh27/pi-retry 当前实现，把它的核心能力迁入 pi-goal。

至少保留：

- stopReason === "error" 的 retry
- permanent/non-retryable error blacklist
- quota/session limit/budget exhaustion 不 retry
- HTTP 400 / 413 retry
- network / connection / timeout / socket 类错误 retry
- credit/payment transient error retry
- exponential backoff
    2s -> 4s -> 8s -> ... -> max 60s
- retryable error 默认 indefinite retry
- stopReason === "length" 自动 continuation
- empty/thinking-only stop 最多 nudge 一次
- /retry
- /retry status
- /retry reset

尽量保留兼容 lifecycle event：

    pi-retry:started
    pi-retry:completed
    pi-retry:cancelled

包括 retryId correlation。

但这些能力必须成为 pi-goal 内部模块，而不是第二个 extension。

建议拆成类似：

    src/
      retry/
        error-patterns.ts
        retry-state.ts
        retry-engine.ts
      lifecycle/
        continuation-coordinator.ts
        background-work.ts
      goal/
        ...

具体目录可以根据当前项目结构调整，不要求机械遵循。

==================================================
三、统一 autonomous-turn 状态机
==================================================

实现一个唯一的 ContinuationCoordinator / LifecycleCoordinator。

任何会触发：

    pi.sendMessage(... triggerTurn: true ...)
    followUp
    continuation
    retry

的行为，都必须经过这个 coordinator。

至少区分以下原因：

    provider_retry
    max_tokens_continue
    empty_response_nudge
    goal_continue
    background_completion_wake
    background_timeout_wake

不要让不同模块直接各自 sendMessage。

优先级必须明确：

    provider retry
        >
    max_tokens continuation
        >
    empty response recovery
        >
    pending external/background wake
        >
    normal goal continuation

同一 agent lifecycle 最多只能安排一次自动下一轮。

必须防止：

    error
      -> retry queued
      -> goal continuation also queued

以及：

    background completion
      -> background plugin wakes Pi
      -> pi-goal simultaneously sends continuation

这种 double wake。

==================================================
四、Goal 模式下 Retry 仍然正常工作
==================================================

Goal active 时不能关闭 retry。

正确行为：

1. Goal active
2. provider 返回 503/network_error
3. retry engine 接管
4. retry 成功
5. 等 retry lifecycle 完全 settled
6. 再决定是否需要 Goal continuation

绝对不能：

    provider error
       ├─ retry
       └─ goal continuation

同时启动两轮。

因此：

    Goal active + error
        -> retry only

    Goal active + length
        -> max_tokens continuation only

    Goal active + empty stop
        -> empty recovery only

只有当这些 recovery lifecycle 全部结束后，
才允许进行普通 Goal continuation 判定。

==================================================
五、Goal complete/pause/clear 必须具有最高停止优先级
==================================================

当前真实环境中已经出现：

    update_goal({ status: "complete" })
    -> Goal marked complete
    -> provider error / retry lifecycle
    -> 又出现
       "Continue working toward the active thread goal."

必须彻底杜绝。

实现 generation / epoch / cancellation token。

以下动作发生时：

    update_goal(complete)
    /goal pause
    /goal clear
    budget_limited
    session reset/reload
    user abort

立即 invalidate：

- pending goal continuation
- pending retry timer
- pending max_tokens continuation
- pending empty nudge
- pending background fallback wake
- 所有属于旧 goal generation 的 callback

所有 delayed callback / timer / microtask / EventBus callback 在真正 sendMessage 前都必须重新检查：

    generation still current?
    goal still active?
    session still same?
    user has not interrupted?
    no higher-priority work exists?

不能只在 timer 创建时检查一次。

Goal complete 后，不允许再出现新的：

    Continue working toward the active thread goal.

==================================================
六、不要再只依赖 agent_end 做 Goal continuation
==================================================

检查当前 Pi SDK 是否支持：

    agent_settled

如果当前依赖版本支持，应优先使用真正 fully-settled 的 lifecycle boundary 做 Goal continuation 判定。

当前 pi-goal 的：

    agent_end
      -> goal active
      -> !ctx.hasPendingMessages()
      -> queueContinuation()

过于早。

目标语义应该是：

    agent/model turn ended
        ↓
    retry?
    compaction?
    queued follow-up?
    steering?
    plugin wake?
        ↓
    全部 settle
        ↓
    再由 coordinator 判断是否执行 Goal continuation

即使使用 agent_settled，也必须保留 coordinator 自己的：

    retryPending
    continuationPending
    backgroundWaiting
    generation

状态。

不要假设 agent_settled 本身能够识别 detached background process。

如果当前 SDK 不支持 agent_settled，
实现等价的 settle/coordinator guard，并保留兼容 fallback。

==================================================
七、支持“模型主动停下来等待后台任务”
==================================================

这是本次修改的重要功能。

典型场景：

    Agent
      ↓
    bg_run cargo test / long build
      ↓
    tool 返回 task id
      ↓
    后台继续运行
      ↓
    Agent 正常 stop
      ↓
    等后台完成
      ↓
    后台 notification
      ↓
    Agent 被唤醒继续 Goal

此时：

    stopReason === "stop"

绝对不能被理解为：

    Goal 已完成

也不能立即：

    Continue working toward the active thread goal.

如果：

    Goal active
    +
    model 正常 stop
    +
    至少一个 background job 仍然 active

则进入：

    WAITING_FOR_BACKGROUND

不要发送任何 Goal continuation。

==================================================
八、首先明确兼容两个后台插件
==================================================

必须至少原生兼容：

    npm:pi-background-tasks
    npm:pi-subagents

不要通过：

- grep TUI 输出
- 解析自然语言
- 猜 tool response
- 读取未公开的内部变量

判断后台状态。

优先使用它们公开的 integration API / EventBus / RPC。

--------------------------------------------------
A. pi-background-tasks
--------------------------------------------------

研究最新：

    npm:pi-background-tasks

当前公开 EventBus 包括：

    pi-background-tasks:request:v1
    pi-background-tasks:response:v1
    pi-background-tasks:terminal:v1

并支持：

    capabilities
    status
    ...

请通过公开 EventBus：

1. 查询当前 Pi session 的 active background tasks
2. 监听 terminal task event
3. 按 task id 去重
4. 只统计当前 session 所拥有的 task
5. 不把其他 Pi session 的任务算进来

注意：

    bg_run

默认 notifyOnCompletion=true /
triggerOnCompletion=true，插件本身可能已经发送 follow-up wake。

因此收到 terminal event 后：

不要立即发送 Goal continuation。

正确方式：

    terminal event
       ↓
    标记 background state dirty
       ↓
    debounce / grace period
       ↓
    重新查询 background status
       ↓
    ctx.hasPendingMessages() ?
       ↓ yes
    让原 background plugin 自己负责 wake
       ↓ no
    如果所有 background task 已结束
    且 Goal active
    且 parent idle
       ↓
    Goal coordinator 才发送 fallback wake

这样避免 double wake。

--------------------------------------------------
B. pi-subagents
--------------------------------------------------

研究最新：

    npm:pi-subagents

优先使用其公开 in-process RPC：

    subagents:rpc:v1:ready
    subagents:rpc:v1:request
    subagents:rpc:v1:reply:<requestId>

RPC 支持：

    status

新版 status / fleet capability 可以返回：

    fleet.totalActive

请用公开 API 判断当前 session 是否仍存在 async/background subagent。

同时利用其公开的 async lifecycle/completion event（如果当前版本提供），
作为快速 wake signal。

但是：

    event 只是 signal
    status snapshot 才是 authoritative state

收到 completion event 后必须重新查询 status。

不要假设一个 subagent complete 就代表全部 subagent complete。

例如：

    reviewer A complete
    reviewer B running

此时仍然必须等待。

只有：

    totalActive === 0

才能认为 pi-subagents 的后台工作已全部结束。

==================================================
九、统一 BackgroundWorkProvider 抽象
==================================================

不要把两个插件的判断逻辑散落在 Goal lifecycle 里。

定义统一接口，例如：

    interface BackgroundWorkProvider {
        name: string;

        getActiveWork(sessionId): Promise<BackgroundWorkSnapshot>;

        subscribe?(onChanged): Dispose;
    }

snapshot 至少包含：

    provider
    activeCount
    activeIds
    state: "known" | "unknown"
    checkedAt

然后实现：

    PiBackgroundTasksAdapter
    PiSubagentsAdapter

Goal 层只能问：

    backgroundWork.hasActiveWork(sessionId)

不要知道具体插件细节。

==================================================
十、为未来其他后台插件提供开放协议
==================================================

目标不是只 hardcode 两个插件。

设计一个轻量、versioned、process-local provider registry，例如：

    Symbol.for("pi-goal.background-work.v1")

允许其他 extension 注册：

    registerBackgroundWorkProvider({
        name,
        listActiveWork,
        wakeChannels / subscribe
    })

设计风格可以参考 pi-subagents 已存在的：

    pi-subagents/background-work

provider contract。

如果能安全复用公开标准就优先复用；
不要复制或 import pi-subagents 私有内部文件。

最终应该做到：

内置 adapter：

    pi-background-tasks
    pi-subagents

第三方：

    register provider
        ↓
    自动被 Goal waiting system 识别

如果一个后台插件完全没有公开状态/event/provider API，
不要假装“自动兼容”。

README 明确说明：

    arbitrary third-party background extensions
    require an adapter/provider registration.

==================================================
十一、后台等待状态机
==================================================

建议内部不要把 WAITING 当成 Goal 的持久状态。

Goal 仍然：

    status = active

另外维护 runtime lifecycle：

    RUNNING
    WAITING_FOR_BACKGROUND
    RETRYING
    CONTINUING
    IDLE

这样不会破坏已有：

    active
    paused
    complete
    budget_limited

Goal persistence schema。

正常 stop 后：

    if goal.status !== active:
        stop

    if retryPending:
        wait

    if pendingMessages:
        wait

    snapshot = await backgroundWork.snapshot()

    if snapshot.activeCount > 0 OR snapshot unknown:
        enter WAITING_FOR_BACKGROUND
        arm wait timeout
        return

    otherwise:
        schedule goal continuation

==================================================
十二、多个后台系统必须全部结束
==================================================

例如：

    pi-background-tasks:
        cargo test running

    pi-subagents:
        reviewer running

此时：

    total background active = 2

cargo test 先结束：

    pi-background-tasks = 0
    pi-subagents = 1

不要唤醒 Goal continuation。

reviewer 也结束：

    pi-background-tasks = 0
    pi-subagents = 0

此时才允许继续。

即：

    ALL known providers idle
        -> may continue

不是：

    ANY provider completed
        -> continue

==================================================
十三、background wait timeout
==================================================

为了防止后台插件：

- 丢 terminal event
- 状态卡死
- child process 已死但 registry 没更新
- provider integration bug

增加 fallback inactivity timeout。

建议默认：

    backgroundWaitTimeoutMs = 15 * 60 * 1000

即 15 分钟。

做成配置项，可以修改或禁用。

重要：

timeout 到期绝对不能：

- 把 background job 标为 completed
- kill background job
- 假设任务成功
- 把 Goal 标为 complete

timeout 的语义仅仅是：

    “等待后台太久没有新的可观察状态变化，
     唤醒主 Agent 一次，让它主动检查情况。”

所以：

    WAITING_FOR_BACKGROUND
        ↓
    15min 无状态变化
        ↓
    re-query all providers
        ↓
    如果全 idle
        -> continue

    如果仍 active / unknown
        -> fallback wake Agent once

发送给 Agent 的 fallback message 应明确类似：

    Background work has not produced a terminal state within the wait timeout.
    Re-check the outstanding background work and decide whether to keep waiting,
    inspect its status/logs, recover it, or continue other useful work.
    Do not assume the background work succeeded.

如果 Agent检查后又选择正常 stop，
并且 background 仍 active，
重新进入 WAITING，并开启新的 timeout epoch。

避免高频 polling。

==================================================
十四、background completion 的正常 wake
==================================================

如果后台插件自己会：

    sendMessage(triggerTurn=true)

则 Goal 不要重复发。

建议增加：

    backgroundWakeGraceMs = 500~1500ms

默认可以取：

    1000ms

最后一个 background terminal event 后：

    wait grace
       ↓
    re-query providers
       ↓
    ctx.hasPendingMessages()
       ↓ yes
    do nothing

如果 parent 已经被 background plugin 唤醒：
    do nothing

只有确认：

    all providers idle
    +
    no pending message
    +
    parent idle
    +
    goal active
    +
    generation unchanged

才发送 fallback Goal continuation。

==================================================
十五、不同 stopReason 的最终行为
==================================================

请实现并测试以下矩阵。

----------------------------------------
无 Goal
----------------------------------------

normal stop
    -> STOP

error retryable
    -> RETRY

error permanent
    -> STOP

length
    -> AUTO CONTINUE

empty/thinking-only
    -> NUDGE ONCE

----------------------------------------
Goal active，无后台
----------------------------------------

normal stop
    -> GOAL CONTINUE

error retryable
    -> RETRY ONLY
       retry settle 后重新判断

error permanent
    -> 不无限 Goal continue
       应停止自动循环并通知用户，必要时 pause Goal

length
    -> MAX-TOKENS CONTINUE ONLY

empty
    -> EMPTY NUDGE ONLY
       最多一次

----------------------------------------
Goal active，有后台任务
----------------------------------------

normal stop
    -> WAIT
       不 Goal continue

error retryable
    -> RETRY
       不因为 background 而吞掉 provider recovery

length
    -> MAX-TOKENS CONTINUE

empty
    -> 按 empty-recovery 规则处理

后台全部完成
    -> 等待 background plugin 自己的 completion wake
       若没有 wake，再 fallback Goal continuation

后台等待超时
    -> wake Agent 检查
       不认为 background 已完成

----------------------------------------
Goal complete/paused/cleared/budget_limited
----------------------------------------

无论：
    retry timer
    background event
    timeout
    length continuation
    old microtask

全部：
    STOP / INVALIDATE

不得继续 Goal。

==================================================
十六、Provider 状态异常时 fail closed
==================================================

如果 background provider：

- status RPC timeout
- 返回 malformed data
- plugin disappearing
- 无法确认任务是否 active

不要错误判断：

    activeCount = 0

而应：

    state = unknown

Goal 正常 stop 时，unknown 按“可能仍有后台任务”处理：

    WAIT

直到：

1. provider 恢复并确认 idle
或
2. background wait timeout 唤醒 Agent 检查

避免因为一次 status query 失败就提前 continuation。

==================================================
十七、处理用户行为
==================================================

用户输入优先级始终最高。

用户：

- 输入新 prompt
- Esc / abort
- /goal pause
- /goal clear
- update_goal complete

都必须正确 invalidate 旧 autonomous schedule。

不要让：

    用户刚按 Esc
       ↓
    2 秒后 retry timer
       ↓
    Agent 又自动启动

也不要：

    /goal pause
       ↓
    background terminal
       ↓
    Goal 又醒来

==================================================
十八、避免 duplicate pi-retry
==================================================

合并完成后 README 明确要求：

    不再同时安装 guoh27/pi-retry

因为 merged pi-goal 已经包含 retry。

如果可行，增加 process-local ownership marker，例如：

    Symbol.for("pi-goal.retry-owner.v1")

以减少重复加载同类 retry engine 的风险。

但不要为了检测另一个插件而依赖它的私有实现。

如果检测到明显的外部 pi-retry lifecycle 正在同时运行，可以 warning：

    Standalone pi-retry appears to be active.
    Disable it because retry is built into pi-goal.

不要自动卸载用户插件。

==================================================
十九、配置
==================================================

尽量保持现有默认行为。

新增配置至少考虑：

    retry.enabled = true
    retry.baseDelayMs = 2000
    retry.maxDelayMs = 60000

    background.enabled = true
    background.waitTimeoutMs = 900000
    background.wakeGraceMs = 1000

默认情况下：

    安装 pi-goal
       =
    Goal + Retry + Background-aware continuation

用户不需要额外开启 retry。

如果没有安装：

    pi-background-tasks
    pi-subagents

background adapter 必须优雅降级，不能报错。

不要把它们设为强制 npm dependency；
优先通过 Pi EventBus / public RPC 做 optional integration。

==================================================
二十、测试要求
==================================================

不要只做单元测试。

至少增加以下测试。

1.
no goal + 503
-> retry
-> success
-> no additional turn

2.
active goal + 503
-> exactly one retry
-> no simultaneous goal continuation

3.
active goal + repeated network error
-> retry backoff
-> no Goal continuation during retry

4.
active goal + length
-> exactly one max-token continuation path
-> no duplicate Goal continuation

5.
active goal + normal stop + no background
-> Goal continuation

6.
active goal + normal stop + pi-background-tasks running
-> no continuation

7.
pi-background-tasks final task completes
-> if its own wake is pending, no duplicate Goal wake

8.
pi-background-tasks final task completes without auto wake
-> Goal performs one fallback wake

9.
active goal + pi-subagents async run
-> normal stop waits

10.
multiple pi-subagents:
A complete
B running
-> still waits

11.
A + B all complete
-> resume exactly once

12.
pi-background-tasks + pi-subagents simultaneously active
-> one completes
-> still waits
-> both idle
-> resume exactly once

13.
background provider status query fails
-> state unknown
-> no premature continuation

14.
background timeout
-> wake Agent
-> do not mark background complete

15.
update_goal(complete) while retry timer pending
-> retry cancelled
-> no continuation

16.
update_goal(complete) while background waiting
-> later background terminal event
-> NO wake

17.
/goal pause while background running
-> background completion
-> NO wake

18.
/goal clear while retry pending
-> NO retry/continuation

19.
user Esc/abort during retry delay
-> retry does not revive Agent

20.
user sends message while Goal continuation is pending
-> user message wins
-> no duplicate automatic turn

21.
background terminal event + provider error race
-> at most one autonomous next turn

22.
stale callback from previous goal generation
-> ignored

23.
session reload
-> preserve current pi-goal reload semantics
-> no stale retry timer survives

24.
standalone non-Goal mode
-> pi-retry behavior remains equivalent to guoh27/pi-retry

==================================================
二十一、增加针对真实 bug 的回归测试
==================================================

必须增加一个 regression test，模拟我实际遇到的顺序：

    goal active
    -> work
    -> provider 503
    -> retry
    -> update_goal({status:"complete"})
    -> another provider/network lifecycle event occurs
    -> coordinator settles

断言：

    goal.status === complete

并且之后永远不存在新的：

    "Continue working toward the active thread goal."

也不存在：

    pi-retry-triggered retry

属于已经 invalidated generation。

==================================================
二十二、验证
==================================================

完成后执行当前仓库已有全部：

- unit tests
- integration tests
- typecheck
- lint
- dead-code checks
- package checks

同时补充新的 lifecycle/background integration tests。

不要为了让测试通过删除已有测试。

确保：

1. 原 pi-goal 功能不回退
2. 原 pi-retry 主要功能不回退
3. 单独安装 pi-goal 即具备 retry
4. Goal + retry 不再竞争 continuation
5. pi-background-tasks 能正确等待
6. pi-subagents background async 能正确等待
7. 多后台 provider 时必须全部结束才继续
8. timeout 只负责安全唤醒，不假定后台完成
9. complete/pause/clear 后不能被任何 stale callback 复活

==================================================
二十三、文档
==================================================

更新 README，增加：

## Built-in retry

说明 pi-goal 已内置原 pi-retry 能力，不需要另装 pi-retry。

## Background-aware goals

解释：

    Agent may stop normally while background work is running.
    pi-goal waits instead of immediately issuing another goal continuation.

明确支持：

    npm:pi-background-tasks
    npm:pi-subagents

说明：

    all tracked background work must settle before normal Goal continuation.

说明 timeout：

    timeout wakes the Agent to investigate;
    it does NOT declare jobs successful or terminate them.

增加架构图：

                        Agent turn
                            |
                            v
                     classify outcome
                            |
          +-----------------+-----------------+
          |                 |                 |
        error             length          normal stop
          |                 |                 |
        retry           continuation           |
                                            Goal active?
                                              |
                                 +------------+------------+
                                 |                         |
                               no Goal                    Goal
                                 |                         |
                                stop              background active?
                                                       |
                                          +------------+-----------+
                                          |                        |
                                         yes                       no
                                          |                        |
                                        WAIT                goal continue
                                          |
                                background terminal
                                          |
                              all providers idle?
                                          |
                                 +--------+--------+
                                 |                 |
                                no                yes
                                 |                 |
                               WAIT       existing wake pending?
                                                   |
                                           +-------+-------+
                                           |               |
                                          yes              no
                                           |               |
                                      let it wake    fallback wake

==================================================
二十四、实现原则
==================================================

- 先阅读两个 fork 当前源码和测试，不要只根据 README 猜实现。
- 再阅读 Pi 当前 Extension API / lifecycle 类型。
- 再阅读最新 pi-background-tasks 与 pi-subagents 的公开 integration API。
- 优先公开 API，不依赖第三方插件私有 implementation details。
- 不抓 UI。
- 不靠字符串猜 active job。
- 不轮询高频 status。
- event 用于 wake，snapshot/status 用于确认真相。
- 所有 autonomous turn 必须经过单一 coordinator。
- 所有 async callback 必须带 generation/session validation。
- Background waiting 不是 Goal completion。
- Timeout 不是 task completion。
- Error retry 不是 Goal continuation。
- Completion event 不是“所有后台任务已完成”的证明。
- 用户输入/停止操作始终高于自动行为。

完成实现后，请给我：

1. 修改的文件列表
2. 新状态机说明
3. retry 与 goal 如何统一
4. pi-background-tasks adapter 实现方式
5. pi-subagents adapter 实现方式
6. background timeout 行为
7. race-condition 防护方式
8. 所有新增测试及结果
9. 与原 pi-goal/pi-retry 行为差异
10. 是否存在仍无法兼容的后台插件类型
11. 不要 commit，保留工作区修改供我 review

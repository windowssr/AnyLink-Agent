<template>
  <view class="screen">
    <view class="topbar">
      <view class="brand"><image src="/static/avatar.png" class="brand-avatar" /><view><text class="name">大肥鱼</text><text class="connection"><text class="dot" :class="{online: connected && !demo}"></text>{{ demo ? '演示预览 · 未调用模型' : connected ? '共同记忆已连接' : '等你带我认识这台手机' }}</text></view></view>
      <button v-if="connected" class="new-chat" :disabled="busy" @click="newChat">新对话</button>
    </view>

    <view class="companion-area" :class="{compact: rows.length}">
      <view class="hello"><text class="eyebrow">ANYLINK · 随身伙伴</text><text class="greeting">{{ busy ? '嗯，我在认真听。' : rows.length ? '一直在你身边。' : '今天，也一起吧。' }}</text><text class="subline">{{ busy ? '正在处理你刚才说的事' : '想聊什么，或者想让我做点什么？' }}</text></view>
      <view class="figure"><CompanionStage :state="expression" @ready="avatarReady = $event" /></view>
    </view>

    <view v-if="!connected" class="connect-card">
      <text class="card-title">把我们的记忆带过来</text>
      <text class="card-copy">导入这台手机的设备连接信息，就能和 Mac 共享记忆。聊天和操作由手机自己完成。</text>
      <textarea v-model="bindingInput" class="binding-input" :maxlength="2048" :auto-height="false" placeholder="粘贴设备连接信息" :disabled="connecting" />
      <button class="connect-button" :disabled="connecting || !bindingInput.trim()" @click="connect">{{ connecting ? '正在连接…' : '和大肥鱼见面' }}</button>
      <button class="demo-button" :disabled="connecting" @click="enterDemo">先看看演示</button>
      <text v-if="notice" class="notice">{{ notice }}</text>
      <text class="privacy">设备凭据仅用于你的服务，不包含模型提供商密钥。</text>
    </view>

    <scroll-view v-else class="conversation" scroll-y :scroll-into-view="scrollTarget" :scroll-with-animation="true">
      <view v-if="!rows.length" class="starters">
        <text class="starter-title">从一件小事开始</text>
        <button v-for="item in starters" :key="item" class="starter" @click="say(item)">{{ item }}<text>↗</text></button>
        <text v-if="temporaryBinding" class="preview-note">浏览器预览只在本次打开期间保留连接。Android 安装版使用本机安全存储。</text>
      </view>
      <view v-for="row in rows" :id="'turn-' + row.id" :key="row.id" class="turn">
        <view class="user-line"><text selectable>{{ row.text }}</text></view>
        <view class="assistant-line"><image src="/static/avatar.png" class="reply-avatar" /><view class="reply-body"><text class="speaker">大肥鱼</text><text v-if="row.answer" class="reply-text" selectable>{{ row.answer }}</text><text v-else-if="row.state === 'submitted'" class="thinking">{{ row.steps?.length ? '我来处理一下…' : '想一想…' }}</text>
          <view v-if="row.steps?.length" class="steps"><view v-for="step in row.steps" :key="step.id" class="step"><text class="step-symbol">{{ step.state === 'completed' ? '✓' : step.state === 'failed' ? '!' : '·' }}</text><text>{{ toolLabel(step.name) }}</text><text class="step-state">{{ step.state === 'completed' ? '完成' : step.state === 'failed' ? '未完成' : '处理中' }}</text></view></view>
          <text v-if="row.notice || row.state === 'submission_unknown'" class="notice">{{ row.notice || '上一轮结果没有确认，重启后没有自动重跑。' }}</text>
          <text class="turn-time">{{ clock(row.started_at) }}</text>
        </view></view>
      </view>
      <view id="conversation-end" class="end-space"></view>
    </scroll-view>

    <view v-if="connected" class="composer-wrap">
      <text v-if="notice" class="composer-notice">{{ notice }}</text>
      <view class="composer"><textarea v-model="draft" class="draft" :maxlength="8000" :auto-height="true" :fixed="true" :cursor-spacing="20" :show-confirm-bar="false" placeholder="和大肥鱼说说话…" :disabled="busy" /><button v-if="busy" class="send stop" @click="stop">■</button><button v-else class="send" :disabled="!draft.trim()" @click="send">↑</button></view>
      <text class="composer-caption">{{ busy ? '点方块随时停止 · 已完成的操作会保留' : demo ? '电脑演示 · 便笺与正式数据分开保存' : '手机执行 · 记忆相通' }}</text>
    </view>
  </view>
</template>
<script>
import CompanionStage from '../../components/CompanionStage.vue';
import {MobileAgent} from '../../core/agent.mjs';
import {Journal} from '../../core/journal.mjs';
import {validateConnection, publicFailure, AgentFailure} from '../../core/protocol.mjs';
import {createTransport} from '../../runtime/transport.mjs';
import {device, createDevice, journalStorage, makeId} from '../../runtime/device.mjs';
import {demoConnection, demoRequest} from '../../runtime/demo.mjs';
import {vault} from '../../runtime/vault.mjs';
let agent, journal, connection;
const labels = {anylink_memory_search: '查询共同记忆', anylink_memory_save: '保存共同记忆', anylink_memory_update: '更正记忆', anylink_memory_delete: '遗忘记忆', anylink_device_status: '读取本机状态', anylink_note_save: '保存手机便笺', anylink_note_list: '读取手机便笺', anylink_companion_expression: '做出表情动作'};
export default {
  components: {CompanionStage},
  data: () => ({connected: false, connecting: false, busy: false, demo: false, avatarReady: false, temporaryBinding: false, bindingInput: '', draft: '', notice: '', rows: [], scrollTarget: '', expression: {emotion: 'neutral', gesture: 'none'}, starters: ['看看这台手机的状态', '帮我写一条便笺：今天开始做安卓版', '你还记得我的哪些偏好？']}),
  onLoad() {
    this.onBackground = () => { agent?.stop(); this.expression = {...this.expression, paused: true}; }; uni.$on('anylink.background', this.onBackground);
    this.onForeground = () => { this.expression = {...this.expression, paused: false}; }; uni.$on('anylink.foreground', this.onForeground);
    try { const saved = vault.load(); if (saved) this.activate(saved); } catch (error) { this.notice = publicFailure(error); }
    // #ifdef H5
    if (typeof location !== 'undefined' && location.origin === 'http://127.0.0.1:5180') {
      fetch('/__anylink/preview-binding', {method: 'POST', headers: {'X-AnyLink-Preview': '1'}}).then(response => response.ok ? response.json() : null).then(value => { if (value && !this.connected && !this.connecting) { this.temporaryBinding = true; this.activate(value); } }).catch(() => {});
    }
    // #endif
  },
  onUnload() { agent?.stop(); uni.$off('anylink.background', this.onBackground); uni.$off('anylink.foreground', this.onForeground); },
  methods: {
    toolLabel(name) { return labels[name] ?? '本机工具'; },
    clock(time) { const d = new Date(time); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
    sync() {
      this.busy = agent?.busy ?? false;
      this.rows = JSON.parse(JSON.stringify(journal.value.runs.filter(r => r.session_id === journal.value.session_id)));
      this.$nextTick(() => { this.scrollTarget = ''; this.$nextTick(() => { this.scrollTarget = 'conversation-end'; }); });
    },
    async activate(value, store = false) {
      this.connecting = true; this.notice = '';
      try {
        const next = validateConnection(value), request = createTransport(next), identity = await request('/edge/v1/identity');
        if (identity.device?.id !== next.device_id || identity.device?.platform !== 'android') throw new AgentFailure('IDENTITY_MISMATCH', '连接信息不是这台 Android 设备的凭据');
        const previousDevice = uni.getStorageSync('anylink.device-id');
        if (previousDevice && previousDevice !== next.device_id) throw new AgentFailure('ALREADY_BOUND', '这份安装已绑定另一台设备，请先核对设备身份');
        if (store) this.temporaryBinding = !vault.save(next).persistent;
        uni.setStorageSync('anylink.device-id', next.device_id); connection = next; journal = new Journal(journalStorage, makeId);
        agent = new MobileAgent({request, connection, device, journal, onChange: () => this.sync(), expression: value => this.express(value)});
        this.connected = true; this.demo = false; this.bindingInput = ''; this.sync();
      } catch (error) { this.notice = publicFailure(error); }
      finally { this.connecting = false; }
    },
    async connect() {
      try { const value = JSON.parse(this.bindingInput); await this.activate(value, true); }
      catch { this.notice = '连接信息格式不完整，请导入这台手机的设备连接 JSON。'; }
    },
    enterDemo() {
      journal = new Journal({read: () => uni.getStorageSync('anylink.demo.journal') || null, write: value => uni.setStorageSync('anylink.demo.journal', JSON.parse(JSON.stringify(value)))}, makeId);
      agent = new MobileAgent({request: demoRequest, connection: demoConnection, device: createDevice('anylink.demo'), journal, onChange: () => this.sync(), expression: value => this.express(value)});
      this.demo = true; this.connected = true; this.notice = ''; this.sync();
    },
    express(value) { this.expression = {...value, sequence: Date.now()}; return {renderer_ready: this.avatarReady}; },
    async say(text) { this.draft = text; await this.send(); },
    async send() {
      const text = this.draft.trim(); if (!text || !agent || this.busy) return;
      this.draft = ''; this.notice = ''; this.expression = {emotion: 'curious', gesture: 'none'};
      try { const run = await agent.send(text); if (!run.steps?.some(s => s.name === 'anylink_companion_expression' && s.state === 'completed')) this.expression = {emotion: run.state === 'completed' ? 'happy' : 'apologetic', gesture: 'none'}; }
      catch (error) { this.notice = publicFailure(error); }
      this.sync();
    },
    stop() { agent?.stop(); },
    newChat() { if (!this.busy) { journal.newConversation(); this.notice = ''; this.sync(); } },
  },
};
</script>
<style scoped>
.screen { height: 100vh; height: 100dvh; max-width: 480px; margin: 0 auto; box-sizing: border-box; display: flex; flex-direction: column; padding-top: var(--status-bar-height); background: radial-gradient(ellipse at 90% 0, #dceefe 0%, transparent 48%), #f2f7fc; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 24rpx 34rpx 8rpx; flex-shrink: 0; }
.brand { display: flex; align-items: center; gap: 16rpx; }.brand-avatar { width: 76rpx; height: 76rpx; border-radius: 24rpx; background: white; }
.name { display: block; font-size: 34rpx; font-weight: 650; letter-spacing: 2rpx; }.connection { display: block; color: #6c8aa0; font-size: 21rpx; margin-top: 5rpx; }.dot { display: inline-block; width: 9rpx; height: 9rpx; border-radius: 50%; background: #a0afbc; margin-right: 8rpx; }.online { background: #4fbda5; }
.new-chat { margin: 0; padding: 4rpx 20rpx; background: #ffffffb3; color: #55768d; font-size: 23rpx; border-radius: 28rpx; }
.companion-area { height: 420rpx; flex-shrink: 0; position: relative; margin: 4rpx 20rpx 0; }.hello { position: absolute; left: 24rpx; top: 82rpx; width: 47%; z-index: 3; }.eyebrow { color: #8aa5bb; font-size: 17rpx; letter-spacing: 3rpx; }.greeting { display: block; font-size: 39rpx; font-weight: 650; margin-top: 23rpx; line-height: 1.5; }.subline { display: block; color: #7891a4; font-size: 23rpx; margin-top: 15rpx; line-height: 1.7; }.figure { position: absolute; right: 0; bottom: 0; width: 53%; height: 100%; }.compact { height: 255rpx; }.compact .hello { top: 32rpx; }.compact .greeting { font-size: 32rpx; margin-top: 13rpx; }.compact .subline { font-size: 21rpx; margin-top: 7rpx; }
.connect-card { margin: 10rpx 34rpx; padding: 34rpx; border: 1rpx solid #fff; border-radius: 32rpx; background: #ffffffdb; box-shadow: 0 18rpx 60rpx #749bb311; }.card-title { display: block; font-size: 33rpx; font-weight: 600; }.card-copy { display: block; font-size: 24rpx; color: #7890a3; line-height: 1.8; margin: 16rpx 0 22rpx; }.binding-input { width: 100%; height: 140rpx; box-sizing: border-box; background: #f2f7fb; padding: 20rpx; border-radius: 18rpx; font-size: 23rpx; }.connect-button { margin-top: 24rpx; background: #397fa9; border-radius: 20rpx; color: white; font-size: 27rpx; }.connect-button[disabled] { background: #c7dbe8; color: #f7fbff; }.privacy { display: block; font-size: 19rpx; line-height: 1.8; color: #9bb0bf; margin-top: 18rpx; }
.demo-button { margin: 15rpx 0 0; border-radius: 20rpx; background: #edf5fb; color: #678aa2; font-size: 24rpx; }
.conversation { flex: 1; min-height: 0; width: 100%; }.starters { padding: 20rpx 36rpx; }.starter-title { font-size: 22rpx; color: #8da3b3; }.starter { display: flex; align-items: center; justify-content: space-between; padding: 22rpx 25rpx; margin: 18rpx 0 0; font-size: 25rpx; text-align: left; color: #52758d; background: #ffffffb3; border: 1rpx solid white; border-radius: 22rpx; line-height: 1.7; }.starter text { color: #9bb8cb; }.preview-note { display: block; margin-top: 18rpx; font-size: 20rpx; color: #8ca1b2; line-height: 1.7; }
.turn { padding: 16rpx 32rpx; }.user-line { display: flex; justify-content: flex-end; margin-bottom: 30rpx; }.user-line>text { max-width: 83%; background: #dceef8; color: #28516d; font-size: 27rpx; line-height: 1.8; padding: 21rpx 27rpx; border-radius: 25rpx 25rpx 6rpx 25rpx; white-space: pre-wrap; }.assistant-line { display: flex; gap: 16rpx; }.reply-avatar { flex-shrink: 0; width: 58rpx; height: 58rpx; border-radius: 20rpx; }.reply-body { flex: 1; min-width: 0; padding-top: 5rpx; }.speaker { display: block; font-size: 22rpx; color: #8aa1b1; margin-bottom: 12rpx; }.reply-text { font-size: 28rpx; line-height: 1.9; white-space: pre-wrap; }.thinking { color: #8aa1b1; font-size: 26rpx; }.steps { padding: 16rpx 20rpx; margin-top: 20rpx; border: 1rpx solid #dce7ef; border-radius: 18rpx; background: #ffffff80; }.step { display: flex; gap: 10rpx; align-items: center; padding: 7rpx 0; font-size: 22rpx; color: #648299; }.step-symbol { color: #4b9a91; }.step-state { margin-left: auto; color: #9aafbe; font-size: 20rpx; }.turn-time { display: block; color: #a9bac7; font-size: 18rpx; margin-top: 14rpx; }.notice { display: block; color: #a57948; font-size: 22rpx; line-height: 1.8; margin-top: 16rpx; }.end-space { height: 30rpx; }
.composer-wrap { flex-shrink: 0; padding: 14rpx 28rpx calc(16rpx + env(safe-area-inset-bottom)); background: #f2f7fc; }.composer { display: flex; align-items: flex-end; gap: 14rpx; background: white; border: 1rpx solid #e0ebf3; padding: 17rpx 18rpx 17rpx 25rpx; border-radius: 28rpx; box-shadow: 0 8rpx 30rpx #6b8ea80c; }.draft { flex: 1; min-height: 48rpx; max-height: 200rpx; padding: 8rpx 0; font-size: 27rpx; line-height: 1.6; }.send { width: 65rpx; height: 65rpx; padding: 0; margin: 0; border-radius: 21rpx; line-height: 65rpx; background: #397fa9; color: white; font-size: 38rpx; flex-shrink: 0; }.send[disabled] { background: #e0ecf4; color: #a0bacb; }.stop { font-size: 24rpx; background: #5d88a4; }.composer-caption { display: block; text-align: center; font-size: 18rpx; letter-spacing: 2rpx; color: #9bb0bf; margin-top: 12rpx; }.composer-notice { display: block; color: #a57948; font-size: 22rpx; padding: 0 10rpx 15rpx; }
</style>

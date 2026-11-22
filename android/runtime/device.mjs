import {AgentFailure} from '../core/protocol.mjs';
export function makeId() {
  if (typeof plus !== 'undefined' && plus.android) return String(plus.android.invoke(plus.android.importClass('java.util.UUID').randomUUID(), 'toString'));
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new AgentFailure('NO_SECURE_RANDOM', '当前运行环境缺少安全随机数，请使用 Android App 或现代浏览器');
}
export const journalStorage = {
  read: () => uni.getStorageSync('anylink.journal.v1') || null,
  write: value => uni.setStorageSync('anylink.journal.v1', JSON.parse(JSON.stringify(value))),
};
export function createDevice(namespace = 'anylink') { return {
  async status() {
    const info = uni.getDeviceInfo(), native = typeof plus !== 'undefined' && plus.os?.name === 'Android';
    const network = await new Promise(resolve => uni.getNetworkType({success: value => resolve(value.networkType), fail: () => resolve('unknown')}));
    const battery = native ? await new Promise(resolve => uni.getBatteryInfo({success: value => resolve({level: value.level, charging: value.isCharging}), fail: () => resolve(null)})) : null;
    return {environment: native ? 'android' : 'browser_preview', model: info.model, os: info.system, network, battery, computer_control: false};
  },
  saveNote({title, content}) {
    const notes = uni.getStorageSync(namespace + '.notes.v1') || [];
    const existing = notes.find(n => n.title === title && n.content === content);
    if (existing) return {...existing, stored_on: 'current_device'};
    if (notes.length >= 100) throw new AgentFailure('NOTES_FULL', '手机便笺已达 100 条，暂时不能继续写入');
    const note = {id: makeId(), title, content, created_at: Date.now()}; notes.push(note); uni.setStorageSync(namespace + '.notes.v1', notes);
    return {...note, stored_on: 'current_device'};
  },
  listNotes() { return {items: uni.getStorageSync(namespace + '.notes.v1') || [], stored_on: 'current_device'}; },
}; }
export const device = createDevice();

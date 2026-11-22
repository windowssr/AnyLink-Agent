// Deliberate, labeled preview fixtures. This is neither a model nor cloud data.
// The real Pi Agent still executes the local tool loop and stores local receipts.
export const demoConnection = {device_id: '00000000-0000-4000-8000-000000000001'};
let sequence = 0;
export async function demoRequest(path, options = {}) {
  if (path === '/edge/v1/context') return {device_id: demoConnection.device_id, global: [], device: []};
  if (path !== '/model/v1/chat/completions') throw new Error('Demo cannot access cloud APIs');
  const history = options.body.messages, last = history[history.length - 1], text = [...history].reverse().find(m => m.role === 'user')?.content ?? '';
  let answer, call;
  if (last.role === 'tool') {
    let value; try { value = JSON.parse(last.content); } catch { value = {}; }
    answer = value.stored_on ? '便笺已保存在这份电脑演示的本地空间。连上真实服务后，手机会使用自己的工作区。' : value.environment ? '本机状态工具已执行。这里是电脑浏览器预览，未读取真实 Android 手机的电量或系统信息。' : '这是大肥鱼的演示动作。正式连接后，我会根据你的话自然地回应。';
  } else if (/便笺/.test(text)) {
    call = {name: 'anylink_note_save', arguments: {title: '安卓版试用', content: text.replace(/^.*[：:]/u, '')}};
  } else if (/状态|电量|网络/.test(text)) call = {name: 'anylink_device_status', arguments: {}};
  else if (/招手|挥手|开心|你好/.test(text)) call = {name: 'anylink_companion_expression', arguments: {emotion: 'happy', gesture: 'wave'}};
  else answer = '我在这里呀。这是明确标注的电脑演示，还没有连接模型和云端记忆；你可以让我招招手、写一条演示便笺，或者查看本机状态。';
  const delta = call ? {tool_calls: [{index: 0, id: 'demo-' + (++sequence), type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}]} : {content: answer};
  options.onText('data: ' + JSON.stringify({choices: [{delta, finish_reason: null}]}) + '\n\n');
  options.onText('data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: call ? 'tool_calls' : 'stop'}]}) + '\n\n');
  options.onText('data: [DONE]\n\n');
  return {status: 200};
}

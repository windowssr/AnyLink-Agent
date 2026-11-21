import { z } from 'zod';
import { ApiError, idempotent, type Db } from './db.js';
import { cancelTask, createTask, deleteMemory, editMemory, listDevices, listTasks, memoryPatchSchema, memorySchema, saveMemory, searchMemories, taskSchema, type Source } from './store.js';
export type ToolContext = Source & { conversationId: string; allowMemoryWrite: boolean };
function definition(name:string,description:string,parameters:object) {return {type:'function',function:{name,description,parameters}};}
const object = (properties:object,required:string[]=[]) => ({type:'object',properties,required,additionalProperties:false});
const str = (description:string) => ({type:'string',description});
export function toolsFor(allowMemoryWrite:boolean) {
  const read=[
    definition('anylink_devices_list','列出主人登记的逻辑设备。执行器均未接入。',object({})),
    definition('anylink_memory_search','查当前有效记忆，支持中文子串。device_id 筛选只返回该设备事实；省略时可以搜索全部。',object({q:str('搜索词，可以为空'),device_id:str('适用设备ID，可省略')})),
    definition('anylink_tasks_list','查看已保存的任务，V0.1 不执行设备操作。',object({})),
    definition('anylink_task_create','仅保存任务并等待执行器接入。必须告知用户并未执行；不知道目标设备时先查询或询问。',object({goal:str('任务目标'),target_device_id:str('目标逻辑设备ID')},['goal','target_device_id'])),
    definition('anylink_task_cancel','取消尚未执行的任务。',object({id:str('任务ID')},['id'])),
  ];
  if(!allowMemoryWrite) return read;
  return [...read,
    definition('anylink_memory_save','仅在用户明确要求记住时保存事实。global 不绑定设备；device 必须提供适用设备。来源设备由服务器记录。',object({title:str('简短主题'),content:str('要记住的事实'),scope:{type:'string',enum:['global','device']},applicable_device_id:str('device作用域的设备ID，全局时省略')},['title','content','scope'])),
    definition('anylink_memory_update','用户明确更正记忆时更新。先查询并使用当前revision。',object({id:str('记忆ID'),content:str('新事实内容'),title:str('可选的新主题'),expected_revision:{type:'integer',minimum:1}},['id','content','expected_revision'])),
    definition('anylink_memory_delete','用户明确要求遗忘时删除当前可召回事实，先查询revision。',object({id:str('记忆ID'),expected_revision:{type:'integer',minimum:1}},['id','expected_revision'])),
  ];
}
export function explicitMemoryIntent(text:string) {
  if(/不要.*(记住|保存|记录)|别.*(记住|保存|记录)|do\s*not\s*(remember|save)|don.t\s*(remember|save)/i.test(text)) return false;
  return /记住|记一下|记下来|保存.{0,20}(记忆|偏好)|更正.{0,20}(记忆|偏好)|更新.{0,20}(记忆|偏好)|忘掉|忘记|删除.{0,20}记忆|remember|forget/i.test(text);
}
export async function executeTool(db:Db,context:ToolContext,name:string,argsText:string,callId:string) {
  if(!toolsFor(context.allowMemoryWrite).some(t=>t.function.name===name)) return {error:{code:'TOOL_NOT_ALLOWED',message:'本轮不允许这个工具；记忆写入需要用户明确要求'}};
  try {
    if(argsText.length>20000) throw new ApiError(400,'INVALID_TOOL_ARGUMENTS','工具参数过大');
    const input=JSON.parse(argsText);
    const result=await idempotent(db,`tool:${context.requestId}`,callId,{name,input},async c=>{
      switch(name) {
        case 'anylink_devices_list': z.object({}).strict().parse(input); return listDevices(c);
        case 'anylink_memory_search': return searchMemories(c,z.object({q:z.string().max(200).optional(),device_id:z.uuid().optional()}).strict().parse(input));
        case 'anylink_tasks_list': z.object({}).strict().parse(input); return listTasks(c);
        case 'anylink_memory_save': return saveMemory(c,memorySchema.parse(input),context);
        case 'anylink_memory_update': { const {id,...body}=z.object({id:z.uuid(),title:z.string().optional(),content:z.string(),expected_revision:z.number().int().positive()}).strict().parse(input); return editMemory(c,id,memoryPatchSchema.parse(body),context); }
        case 'anylink_memory_delete': {const v=z.object({id:z.uuid(),expected_revision:z.number().int().positive()}).strict().parse(input); return deleteMemory(c,v.id,v.expected_revision);}
        case 'anylink_task_create': return createTask(c,taskSchema.parse({...input,conversation_id:context.conversationId}),context);
        case 'anylink_task_cancel': return cancelTask(c,z.object({id:z.uuid()}).strict().parse(input).id);
        default: throw new ApiError(400,'UNKNOWN_TOOL','未知工具');
      }
    });
    return result.value;
  } catch(e) {
    return {error:{code:e instanceof ApiError?e.code:'INVALID_TOOL_ARGUMENTS',message:e instanceof ApiError?e.message:'工具参数不符合要求，请检查后重试'}};
  }
}

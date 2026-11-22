import {execFileSync} from 'node:child_process';
const git=(args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(git(['branch','--show-current'])!=='main'||git(['status','--porcelain']))throw new Error('Sync a clean main checkout; commit intended changes first');
for(const [remote,expected] of [['origin','https://gitee.com/windowssr/anylink-agent.git'],['github','https://github.com/windowssr/AnyLink-Agent.git']]){
 if(git(['remote','get-url',remote])!==expected)throw new Error('Unexpected '+remote+' URL; preserving repository configuration');
 execFileSync('git',['fetch',remote,'main'],{stdio:'inherit'});
 try{execFileSync('git',['merge-base','--is-ancestor',`${remote}/main`,'HEAD'],{stdio:'pipe'});}catch{throw new Error(remote+' has divergent changes. Merge and validate them before syncing; never force push.');}
}
if(process.argv.includes('--check')){console.log('Both remote main branches can fast-forward to this checkout');process.exit(0);}
execFileSync(process.execPath,['scripts/audit-public.mjs'],{stdio:'inherit'});
for(const remote of ['origin','github'])execFileSync('git',['push',remote,'main','--follow-tags'],{stdio:'inherit'});
const head=git(['rev-parse','HEAD']);
for(const remote of ['origin','github'])if(git(['ls-remote',remote,'refs/heads/main']).split(/\s/)[0]!==head)throw new Error(remote+' did not confirm the expected commit; inspect before retrying');
console.log('GitHub and Gitee main both confirmed at '+head);

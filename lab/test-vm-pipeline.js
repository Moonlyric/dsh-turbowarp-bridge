// M0 headless 验证：scratch-vm 核心管线（读/写/造型）
// 验证目标：
//   1. loadProject 能吃 sb3 JSON
//   2. saveProjectSb3DontZip 能读出 project.json（AI 读链路）
//   3. shareBlocksToTarget 能注入块（AI 写链路，含扩展自动加载）
//   4. emitWorkspaceUpdate 不炸（GUI 刷新信号）
//   5. addCostume 能加 SVG 造型（AI 造型链路）
//   6. 注入后能拿到新块 ID 映射（回传给 AI 的关键）

const { ScratchStorage, AssetType } = require('scratch-storage');

// 序列化快照（兼容两代 API）：
// turbowarp.org 线上（LLK 老版）有 saveProjectSb3DontZip；npm scratchfoundation 5.x 用 toJSON
async function snapshotJson(vm) {
  if (typeof vm.saveProjectSb3DontZip === 'function') return vm.saveProjectSb3DontZip();
  return JSON.parse(vm.toJSON());
}

// ---------- 最小 sb3 项目（project.json 格式） ----------
function minimalProject() {
  return {
    targets: [
      {
        isStage: true, name: 'Stage',
        variables: { '`jEk@4|i[#Fk?8Y)wLL': ['my variable', 0] },
        lists: {}, broadcasts: {}, blocks: {}, comments: {},
        currentCostume: 0,
        costumes: [{
          name: 'backdrop1',
          assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
          md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg',
          dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180
        }],
        sounds: [], volume: 100, layerOrder: 0,
        tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null
      },
      {
        isStage: false, name: 'Sprite1',
        variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
        currentCostume: 0,
        costumes: [{
          name: 'costume1',
          assetId: 'b7853f2ac4437269839b22653b82f7c9',
          md5ext: 'b7853f2ac4437269839b22653b82f7c9.svg',
          dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 50
        }],
        sounds: [{ name: 'pop', assetId: '83a9787d4cb6f3b7632b1dd40bf1fb5e', md5ext: '83a9787d4cb6f3b7632b1dd40bf1fb5e.wav', dataFormat: 'wav', format: '', rate: 44100, sampleCount: 258, channels: 1 }],
        volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'm0-test' }
  };
}

// ---------- AI 要注入的积木（sb3 blocks dict，模拟 dsh 工具的参数） ----------
// 老版（turbowarp.org 线上 / LLK）吃 dict 格式；npm 5.x 吃 array 格式（元素带 id）。
// dictToArray 做宿主适配，两种都验证。
function dictToArray(dict) {
  return Object.keys(dict).map(id => Object.assign({ id }, dict[id]));
}

function blocksToInject() {
  return dictToArray({
    'ai_hat_1': {
      opcode: 'event_whenflagclicked', next: 'ai_move_2', parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 60
    },
    'ai_move_2': {
      opcode: 'motion_movesteps', next: 'ai_say_3', parent: 'ai_hat_1',
      inputs: { STEPS: [1, [4, '50']] }, fields: {}, shadow: false, topLevel: false
    },
    'ai_say_3': {
      opcode: 'looks_sayforsecs', next: null, parent: 'ai_move_2',
      inputs: { MESSAGE: [1, [10, '你好，我是AI注入的!']], SECS: [1, [4, '2']] },
      fields: {}, shadow: false, topLevel: false
    }
  });
}

// pen 扩展块（验证扩展自动加载管线）
function penBlocksToInject() {
  return dictToArray({
    'ai_pen_hat': {
      opcode: 'pen_clear', next: null, parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 300
    }
  });
}

async function main() {
  console.log('[1] 启动 headless VM...');
  const VM = (await import('scratch-vm')).default;
  const vm = new VM();
  const storage = new ScratchStorage();
  vm.attachStorage(storage);
  // headless stub renderer：scratch-vm 的 costume/drawable 管线硬依赖 renderer API，
  // stub 掉即可（真浏览器里由 scratch-render WebGL 提供）
  let drawableIdSeq = 0;
  vm.runtime.renderer = {
    createSVGSkin: () => 'skin-stub',
    createBitmapSkin: () => 'skin-stub',
    getSkinSize: () => [48, 50],
    getCurrentSkinSize: () => [48, 50],
    getSkinRotationCenter: () => [48, 50],
    destroySkin: () => {},
    isFlashRenderer: () => false,
    createDrawable: () => ++drawableIdSeq,
    destroyDrawable: () => {},
    getDrawableOrder: () => 0,
    setDrawableOrder: () => 0,
    setLayerGroupOrdering: () => {},
    updateDrawableDirectionScale: () => {},
    updateDrawableEffect: () => {},
    updateDrawablePosition: () => {},
    updateDrawableSkinId: () => {},
    updateDrawableVisible: () => {},
    isTouchingColor: () => false,
    isTouchingDrawables: () => false,
    drawableTouching: () => false,
    getFencedPositionOfDrawable: p => p,
    draw: () => {}
  };

  console.log('[2] loadProject(最小 sb3 JSON)...');
  await vm.loadProject(minimalProject());
  const sprite = vm.runtime.targets.find(t => !t.isStage);
  console.log('    OK, targets:', vm.runtime.targets.map(t => `${t.getName()}${t.isStage ? '(stage)' : ''}`).join(', '), '| sprite.id =', sprite.id);

  console.log('[3] READ: 序列化项目 JSON...');
  let pj = await snapshotJson(vm);
  const before = pj.targets.find(t => !t.isStage).blocks;
  console.log('    OK, project.json keys:', Object.keys(pj).join(','), '| sprite 块数:', Object.keys(before).length);

  console.log('[4] WRITE: shareBlocksToTarget(普通积木)...');
  const injected = blocksToInject();
  const oldIds = Object.keys(injected);
  await vm.shareBlocksToTarget(injected, sprite.id);
  console.log('    OK（无异常）');

  console.log('[5] 验证注入结果 + 新旧 ID 映射...');
  pj = await snapshotJson(vm);
  const after = pj.targets.find(t => !t.isStage).blocks;
  const newIds = Object.keys(after).filter(id => !before[id]);
  console.log(`    sprite 块数: ${Object.keys(before).length} -> ${Object.keys(after).length}（新增 ${newIds.length} 个）`);
  // shareBlocksToTarget 内部 newBlockIds 会换 ID：验证旧 ID 不在、新 ID 在
  const idMapped = !oldIds.some(id => after[id]) && newIds.length === oldIds.length;
  console.log('    ID 全部换新:', idMapped ? 'YES（插件必须回传新 ID 映射给 AI）' : 'NO');
  // 找到链头（topLevel 且 opcode 是绿旗）
  const hat = Object.values(after).find(b => b.opcode === 'event_whenflagclicked' && b.topLevel);
  console.log('    绿旗块新坐标:', `x=${hat.x}, y=${hat.y}`, '| 链:', hat.opcode, '->', after[hat.next].opcode, '->', after[after[hat.next].next].opcode);

  console.log('[6] emitWorkspaceUpdate()...');
  vm.emitWorkspaceUpdate();
  console.log('    OK（GUI 未连接时不炸）');

  console.log('[7] WRITE: shareBlocksToTarget(pen 扩展块 → 验证扩展自动加载)...');
  try {
    await vm.shareBlocksToTarget(penBlocksToInject(), sprite.id);
    pj = await snapshotJson(vm);
    const hasPen = pj.extensions.includes('pen');
    console.log('    OK, extensions =', JSON.stringify(pj.extensions), '| pen 自动加载:', hasPen ? 'YES' : 'NO');
  } catch (e) {
    console.log('    pen 注入异常:', e.message);
  }

  console.log('[8] addCostume(SVG 造型)...');
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="40" fill="#575E75"/></svg>';
    const asset = storage.createAsset(AssetType.SVG, 'svg', svg, null, true);
    const md5ext = asset.assetId + '.' + asset.dataFormat;
    await vm.addCostume(md5ext, {
      name: 'ai-costume', md5ext, dataFormat: 'svg',
      rotationCenterX: 48, rotationCenterY: 48
    }, sprite.id);
    const s2 = vm.runtime.targets.find(t => !t.isStage);
    console.log('    OK, 造型列表:', s2.getCostumes().map(c => c.name).join(', '));
  } catch (e) {
    console.log('    addCostume 异常:', e.message);
  }

  console.log('\n===== M0 管线验证完成 =====');
  vm.stopAll();
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });

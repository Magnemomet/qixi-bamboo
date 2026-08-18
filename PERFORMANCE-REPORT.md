# 竹蜻蜓 v2 性能优化报告

日期：2026-08-18

## 约束

本轮只做代码效率优化，未修改以下画质参数或视觉资产：

- `pixelRatio`
- `antialias`
- 粒子数量
- 阴影设置
- 模型细节与材质效果

`scene.js` 经检查没有需要删除的冗余渲染设置，相机每帧 `lookAt` 保留。

## 已落地优化

### 1. world.update 分层懒更新

- 13 层权重每帧只计算一次，天空色板复用该数组，不再由 `updateSky` 重复计算。
- 权重小于等于 `0.02` 的层直接隐藏并跳过 fade、动态位置与粒子更新。
- 通常每帧只有 2 至 3 个活跃层进入更新。
- `registerFade` 在初始化阶段缓存每层透明材质列表。
- 每帧 fade 通过缓存材质列表更新，不再对层级执行 `traverse`。
- 静态材质仅在权重变化达到 `0.0005` 时写入 opacity。
- 动态层的云、飞机、卫星、叶片、冰粒子等只在所在层活跃时更新。

### 2. 几何共享

新增 `geometryCache` 与缩放式 mesh 工具，以下对象改用共享基础 geometry：

- 灌木球体
- 三层远景树海平面
- 四层树冠圆锥
- 50 栋楼体与楼顶设备箱
- 楼顶薄云球体 lobes
- 云海近景球体 lobes
- 平流层球体云 lobes
- 竹蜻蜓两片桨叶

尺寸差异通过 `mesh.scale` 保持，段数、形状、材质和视觉体量不变。

### 3. HUD DOM 节流

- HUD 数字刷新间隔设为 100ms。
- 高度、单位、转速、分数、最佳分数和层级均缓存上次展示值。
- 只有展示值变化时才写 `textContent`。
- 高度单位 DOM 引用在 init 阶段缓存，不再每帧 `querySelector`。

### 4. bamboo.js

- 残影几何原本已在 init 阶段创建，每帧只改 opacity 和 rotation，无需再改。
- 两片桨叶改为共享 geometry、texture、material。
- `getPos()` 复用一个 `Vector3`，移除每帧 clone 分配。

## 性能验收

基线数据：

- draw calls：91
- geometries：84
- triangles：9064

优化后使用 Edge headless + SwiftShader，对 13 层逐层渲染以触发全部 geometry 上传，再返回云层实测：

- draw calls：6（云层当前帧；目标不高于 60）
- geometries：90（未达到不高于 45 的目标）
- triangles：968（云层当前帧）

说明：draw call 因非活跃层跳过渲染而显著下降。`renderer.info.memory.geometries` 统计的是本次探针中曾上传 GPU 的全部 geometry；本轮已经共享高重复对象，但项目仍有大量一次性独特 geometry，尚未达到 45。若继续压低该数字，需要扩大几何缓存覆盖面，或对楼群、树阵、平台实施 InstancedMesh / 批量合并。当前没有冒进改造，以避免改变随机布局、材质表现和透明排序。

## 语法检查

```text
=== node --check js/world.js ===
=== node --check js/ui.js ===
=== node --check js/scene.js ===
=== node --check js/bamboo.js ===
ALL NODE CHECKS PASSED
```

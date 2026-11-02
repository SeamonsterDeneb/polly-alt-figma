/// <reference types="@figma/plugin-typings" />

// Polly Alt - Figma Canvas Engine
figma.showUI(__html__, {
  width: 440,
  height: 620,
  themeColors: true
});

// Restore saved window dimensions
figma.clientStorage.getAsync('polly_window_size').then(size => {
  if (size && size.width && size.height) {
    figma.ui.resize(size.width, size.height);
  }
}).catch(() => {});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return figma.base64Encode(bytes);
}

function extractNodeContext(node: SceneNode) {
  const context = {
    frameName: '',
    isFunctional: false,
    functionalRole: '',
    destination: '',
    destinationTitle: '',
    paragraphsBefore: '',
    paragraphsAfter: ''
  };

  const pageFrame = topLevelOf(node);
  context.frameName = pageFrame.id !== node.id ? pageFrame.name : '';

  if ('reactions' in node && node.reactions && node.reactions.length > 0) {
    for (const reaction of node.reactions) {
      if (reaction.action) {
        if (reaction.action.type === 'URL') {
          context.isFunctional = true;
          context.functionalRole = 'link';
          context.destination = reaction.action.url;
          break;
        } else if (reaction.action.type === 'NODE' && reaction.action.destinationId) {
          const destNode = figma.getNodeById(reaction.action.destinationId);
          if (destNode) {
            context.isFunctional = true;
            context.functionalRole = 'button';
            context.destinationTitle = destNode.name;
            break;
          }
        }
      }
    }
  }

  const combinedNames = `${node.name} ${node.parent ? node.parent.name : ''}`.toLowerCase();
  if (!context.isFunctional) {
    if (combinedNames.includes('btn') || combinedNames.includes('button') || combinedNames.includes('cta')) {
      context.isFunctional = true;
      context.functionalRole = 'button';
      context.destinationTitle = node.name;
    } else if (combinedNames.includes('link') || combinedNames.includes('nav')) {
      context.isFunctional = true;
      context.functionalRole = 'link';
      context.destination = node.name;
    }
  }

  const imgBox = node.absoluteBoundingBox;
  if (imgBox) {
    const scope: any = pageFrame.id !== node.id && 'findAllWithCriteria' in pageFrame ? pageFrame : figma.currentPage;
    const imgRight = imgBox.x + imgBox.width;
    const imgBottom = imgBox.y + imgBox.height;
    const above: { text: string; gap: number }[] = [];
    const below: { text: string; gap: number }[] = [];

    for (const t of scope.findAllWithCriteria({ types: ['TEXT'] }) as TextNode[]) {
      const text = t.characters ? t.characters.trim() : '';
      const tb = t.absoluteBoundingBox;
      if (text.length <= 10 || !tb || !isShown(t) || isPollyNode(t)) continue;

      let inside = false;
      for (let p: BaseNode | null = t.parent; p && p.type !== 'PAGE'; p = p.parent) {
        if (p.id === node.id) { inside = true; break; }
      }
      if (inside) continue;

      if (tb.x + tb.width <= imgBox.x || tb.x >= imgRight) continue;

      if (tb.y + tb.height <= imgBox.y + 15) {
        const gap = imgBox.y - (tb.y + tb.height);
        if (gap <= 600) above.push({ text, gap });
      } else if (tb.y >= imgBottom - 15) {
        const gap = tb.y - imgBottom;
        if (gap <= 600) below.push({ text, gap });
      }
    }

    above.sort((a, b) => b.gap - a.gap);
    below.sort((a, b) => a.gap - b.gap);
    if (above.length > 0) context.paragraphsBefore = above.slice(-2).map(a => a.text).join('\n\n');
    if (below.length > 0) context.paragraphsAfter = below.slice(0, 2).map(a => a.text).join('\n\n');
  }

  return context;
}

// Send current selection state to UI
async function sendCurrentSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'SELECTION_CLEARED' });
    return;
  }

  let node = selection[0];

  // If the designer clicked the Squawk Curtain overlay, redirect focus to the actual image
  if (node.getPluginData('polly_is_squawk_overlay') === 'true' || node.getPluginData('polly_is_deco_overlay') === 'true' || node.getPluginData('polly_is_focus_ring') === 'true') {
    const targetId = node.getPluginData('polly_target_image_id');
    const realImageNode = targetId ? figma.getNodeById(targetId) as SceneNode : null;
    if (realImageNode && !realImageNode.removed) {
      figma.currentPage.selection = [realImageNode];
      figma.ui.postMessage({ type: 'PULSE_GENERATE' });
      return;
    }
  }

  let hasImage = false;

  // Check if layer has an Image paint fill
  if ('fills' in node && Array.isArray(node.fills)) {
    hasImage = node.fills.some(f => f.type === 'IMAGE');
  }

  // Frames, components, or instances can also represent graphics
  if (!hasImage && (node.type === 'FRAME' || node.type === 'RECTANGLE' || node.type === 'INSTANCE' || node.type === 'COMPONENT')) {
    hasImage = true;
  }

  let previewBase64 = '';
  if (hasImage) {
    // Retry up to 3 times to allow newly dropped bitmaps to finish GPU rasterization
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const previewBytes = await node.exportAsync({
          format: 'JPG',
          constraint: { type: 'WIDTH', value: 800 }
        });
        previewBase64 = uint8ArrayToBase64(previewBytes);
        if (previewBase64) break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 180));
      }
    }
  }

  const existingAlt = node.getPluginData('polly_alt') || '';
  const isDecorative = node.getPluginData('polly_is_decorative') === 'true';
  const context = extractNodeContext(node);
  const noteId = node.getPluginData('polly_margin_note_id');
  const isPinned = !!noteId && !!figma.getNodeById(noteId);

  figma.ui.postMessage({
    type: 'SELECTION_READY',
    data: {
      nodeId: node.id,
      nodeName: node.name,
      hasImage,
      existingAlt,
      isDecorative,
      isPinned,
      context,
      previewBase64
    }
  });
}

let isSelfUpdating = false;
const recentlySquawked = new Set<string>();
let lastCreateAt = 0;
let overlaySyncTimer: any = null;
const SCRIM_OPACITY = 0.68;
let autoAdvance = true;
let advanceTimer: any = null;
let focusRingId: string | null = null;
let focusTargetId: string | null = null;
let focusPulseTimer: any = null;

async function waitForImageFill(node: BaseNode, tries = 12): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (node.removed || !('fills' in node)) return false;
    if ('fills' in node && Array.isArray((node as any).fills) && (node as any).fills.some((f: Paint) => f.type === 'IMAGE')) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function findAnnotationLayer(): FrameNode | null {
  const layer = figma.currentPage.children.find(n => n.getPluginData('polly_is_annotation_layer') === 'true');
  return layer && layer.type === 'FRAME' ? layer : null;
}

function addToAnnotationLayer(node: SceneNode, reveal = true) {
  let layer = findAnnotationLayer();
  if (!layer) {
    layer = figma.createFrame();
    layer.name = '🦜 Polly Alt Annotations';
    layer.x = 0;
    layer.y = 0;
    layer.resize(1, 1);
    layer.fills = [];
    layer.clipsContent = false;
    layer.setPluginData('polly_is_annotation_layer', 'true');
    figma.ui.postMessage({ type: 'ANNOTATIONS_VISIBLE', visible: true });
  }
  layer.appendChild(node);
  if (reveal && !layer.visible) {
    layer.visible = true;
    figma.ui.postMessage({ type: 'ANNOTATIONS_VISIBLE', visible: true });
  }
  const pageChildren = figma.currentPage.children;
  if (pageChildren[pageChildren.length - 1] !== layer) figma.currentPage.appendChild(layer);
}

function clearPollyAnnotations(node: SceneNode) {
  const keys = ['polly_margin_note_id', 'polly_margin_line_id', 'polly_margin_halo_id', 'polly_margin_dot_id', 'polly_deco_overlay_id', 'polly_badge_id'];
  for (const key of keys) {
    const id = node.getPluginData(key);
    if (!id) continue;
    const target = figma.getNodeById(id);
    if (target && !target.removed) target.remove();
    node.setPluginData(key, '');
  }
}

async function createDecorativeOverlay(imgNode: SceneNode) {
  await createScrimOverlay(imgNode, 'decorative');
}

// Helper: Remove any squawk overlay attached to an image
function removeSquawkOverlay(imgNode: SceneNode) {
  const overlayId = imgNode.getPluginData('polly_squawk_overlay_id');
  if (overlayId) {
    const overlay = figma.getNodeById(overlayId);
    if (overlay && !overlay.removed) {
      overlay.remove();
    }
    imgNode.setPluginData('polly_squawk_overlay_id', '');
  }
}

function isPollyNode(node: BaseNode): boolean {
  const flags = ['polly_is_margin_card', 'polly_is_guide_line', 'polly_is_squawk_overlay', 'polly_is_deco_overlay', 'polly_is_badge', 'polly_is_annotation_layer'];
  const has = (n: BaseNode | null) => !!n && 'getPluginData' in n && flags.some(f => (n as any).getPluginData(f) === 'true');
  return has(node) || has(node.parent);
}

function isShown(node: BaseNode | null): boolean {
  let p: BaseNode | null = node;
  while (p && p.type !== 'PAGE') {
    if ('visible' in p && !p.visible) return false;
    p = p.parent;
  }
  return true;
}

function isUndescribedImage(n: SceneNode): boolean {
  if (!('fills' in n) || isPollyNode(n) || !isShown(n)) return false;
  const fills = (n as any).fills;
  if (!Array.isArray(fills) || !fills.some((f: Paint) => f.type === 'IMAGE' && f.visible !== false)) return false;
  return !n.getPluginData('polly_alt') && n.getPluginData('polly_is_decorative') !== 'true';
}

function syncOverlays() {
  const layer = findAnnotationLayer();
  if (!layer) return;
  for (const o of layer.children.slice() as FrameNode[]) {
    if (o.getPluginData('polly_is_squawk_overlay') !== 'true' && o.getPluginData('polly_is_deco_overlay') !== 'true') continue;
    const target = figma.getNodeById(o.getPluginData('polly_target_image_id')) as SceneNode | null;
    if (!target || target.removed) {
      o.remove();
      continue;
    }
    const b = target.absoluteBoundingBox;
    if (!b) continue;
    const shown = isShown(target);
    if (o.visible !== shown) o.visible = shown;
    if (Math.abs(o.x - b.x) > 0.5 || Math.abs(o.y - b.y) > 0.5) {
      o.x = b.x;
      o.y = b.y;
    }
    if (Math.abs(o.width - b.width) > 0.5 || Math.abs(o.height - b.height) > 0.5) {
      o.resize(Math.max(b.width, 1), Math.max(b.height, 1));
    }
  }
}

function scheduleOverlaySync() {
  if (overlaySyncTimer) return;
  overlaySyncTimer = setTimeout(() => {
    overlaySyncTimer = null;
    syncOverlays();
    sendMissingCount();
  }, 150);
}

function topLevelOf(n: SceneNode): SceneNode {
  let p: BaseNode = n;
  while (p.parent && p.parent.type !== 'PAGE') p = p.parent;
  return p as SceneNode;
}

function byReadingOrder(a: SceneNode, b: SceneNode): number {
  const ta = topLevelOf(a);
  const tb = topLevelOf(b);
  if (ta.id !== tb.id) {
    const ra = ta.absoluteBoundingBox;
    const rb = tb.absoluteBoundingBox;
    if (ra && rb) return Math.abs(ra.y - rb.y) > 20 ? ra.y - rb.y : ra.x - rb.x;
  }
  const ba = a.absoluteBoundingBox;
  const bb = b.absoluteBoundingBox;
  if (!ba || !bb) return 0;
  return Math.abs(ba.y - bb.y) > 20 ? ba.y - bb.y : ba.x - bb.x;
}

function missingImages(keepId: string | null = null): SceneNode[] {
  const found = figma.currentPage.findAll(n => isUndescribedImage(n as SceneNode) || n.id === keepId) as SceneNode[];
  return found.sort(byReadingOrder);
}

function setStatus(text: string) {
  figma.ui.postMessage({ type: 'STATUS', text });
}

function sendMissingCount() {
  figma.ui.postMessage({ type: 'MISSING_COUNT', count: missingImages().length });
}

function clearFocusRing() {
  if (focusPulseTimer) {
    clearInterval(focusPulseTimer);
    focusPulseTimer = null;
  }
  const ring = focusRingId ? figma.getNodeById(focusRingId) : null;
  if (ring && !ring.removed) ring.remove();
  focusRingId = null;
  focusTargetId = null;
}

function showFocusRing(target: SceneNode) {
  clearFocusRing();
  const b = target.absoluteBoundingBox;
  if (!b) return;

  const green = { r: 8 / 255, g: 137 / 255, b: 8 / 255 };
  const weight = Math.max(5, Math.round(4 / figma.viewport.zoom));
  const ring = figma.createFrame();
  ring.name = '[Polly Focus]';
  ring.resize(Math.max(b.width, 1), Math.max(b.height, 1));
  ring.fills = [];
  ring.clipsContent = false;
  ring.strokes = [{ type: 'SOLID', color: green }];
  ring.strokeAlign = 'OUTSIDE';
  ring.strokeWeight = weight;
  ring.setPluginData('polly_is_focus_ring', 'true');
  ring.setPluginData('polly_target_image_id', target.id);
  addToAnnotationLayer(ring, true);
  ring.x = b.x;
  ring.y = b.y;
  focusRingId = ring.id;
  focusTargetId = target.id;

  let tick = 0;
  focusPulseTimer = setInterval(() => {
    tick++;
    const r = focusRingId ? figma.getNodeById(focusRingId) as FrameNode | null : null;
    if (!r || r.removed || tick >= 8) {
      clearInterval(focusPulseTimer);
      focusPulseTimer = null;
      if (r && !r.removed) {
        r.strokeWeight = weight;
        r.strokes = [{ type: 'SOLID', color: green }];
      }
      return;
    }
    const high = tick % 2 === 0;
    r.strokeWeight = high ? weight : Math.round(weight * 2.4);
    r.strokes = [{ type: 'SOLID', color: green, opacity: high ? 1 : 0.45 }];
  }, 375);
}

function bringIntoView(node: SceneNode) {
  const page = topLevelOf(node);
  const b = page.absoluteBoundingBox;
  if (!b) return;
  const v = figma.viewport.bounds;
  const wholePageVisible = b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height;
  if (wholePageVisible) return;
  figma.viewport.scrollAndZoomIntoView([page]);
  if (figma.viewport.zoom > 1) figma.viewport.zoom = 1;
}

async function goToNextMissing(): Promise<boolean> {
  const sel = figma.currentPage.selection[0];
  let fromId: string | null = sel ? sel.id : null;
  if (sel && sel.getPluginData('polly_target_image_id')) fromId = sel.getPluginData('polly_target_image_id');

  const list = missingImages(fromId);
  const idx = fromId ? list.findIndex(n => n.id === fromId) : -1;
  let next: SceneNode | null = null;
  for (let i = 1; i <= list.length; i++) {
    const cand = list[(idx + i + list.length) % list.length];
    if (cand.id !== fromId) {
      next = cand;
      break;
    }
  }

  if (!next) {
    figma.notify(list.some(n => n.id !== fromId) || (fromId && isUndescribedImage(figma.getNodeById(fromId) as SceneNode))
      ? '🦜 This is the only image missing alt text.'
      : '🦜 Every image on this page has alt text!');
    sendMissingCount();
    return false;
  }

  focusTargetId = next.id;
  figma.currentPage.selection = [next];
  bringIntoView(next);
  showFocusRing(next);
  figma.ui.postMessage({ type: 'PULSE_GENERATE' });
  sendMissingCount();
  return true;
}

function runPollyDiagnostic() {
  const t: Record<string, number> = {
    nodesOnPage: 0, pollyOwned: 0, hasFillsArray: 0, hasImageFill: 0, imageFillButInvisible: 0,
    imageFillHiddenByAncestor: 0, hasAltSaved: 0, markedDecorative: 0, passesFilter: 0,
    passingWithLiveOldScrim: 0, passingInsideInstance: 0, passingSetPluginDataFails: 0,
    frameOrComponentOrInstanceWithoutImageFill: 0
  };
  const imageFillTypes: Record<string, number> = {};
  const sample: string[] = [];
  const all = figma.currentPage.findAll(() => true);
  for (const n of all) {
    t.nodesOnPage++;
    try {
      if (isPollyNode(n)) { t.pollyOwned++; continue; }
      const fills = (n as any).fills;
      if (Array.isArray(fills)) {
        t.hasFillsArray++;
        const img = fills.filter((f: Paint) => f.type === 'IMAGE');
        if (img.length) {
          t.hasImageFill++;
          imageFillTypes[n.type] = (imageFillTypes[n.type] || 0) + 1;
          if (!img.some((f: Paint) => f.visible !== false)) t.imageFillButInvisible++;
          if (!isShown(n)) t.imageFillHiddenByAncestor++;
          if (n.getPluginData('polly_alt')) t.hasAltSaved++;
          if (n.getPluginData('polly_is_decorative') === 'true') t.markedDecorative++;
        } else if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
          t.frameOrComponentOrInstanceWithoutImageFill++;
        }
      }
      if (isUndescribedImage(n as SceneNode)) {
        t.passesFilter++;
        if (sample.length < 5) sample.push(n.type + ' "' + n.name + '"');
        const oid = n.getPluginData('polly_squawk_overlay_id');
        const old = oid ? figma.getNodeById(oid) : null;
        if (old && !old.removed) t.passingWithLiveOldScrim++;
        let p: BaseNode | null = n.parent;
        while (p && p.type !== 'PAGE') { if (p.type === 'INSTANCE') { t.passingInsideInstance++; break; } p = p.parent; }
        try { n.setPluginData('polly_probe', '1'); n.setPluginData('polly_probe', ''); } catch (e) { t.passingSetPluginDataFails++; }
      }
    } catch (e) {
      t.errors = (t.errors || 0) + 1;
    }
  }
  console.log('POLLY DIAGNOSTIC', JSON.stringify({ page: figma.currentPage.name, totals: t, imageFillNodeTypes: imageFillTypes, sampleOfPassing: sample }, null, 2));
  figma.notify('🦜 Diagnostic printed to the console (' + t.passesFilter + ' pass the filter)');
}

async function squawkAllMissingAlt() {
  setStatus('🔍 Scanning for images missing alt…');
  await new Promise(r => setTimeout(r, 60));
  const targets = figma.currentPage.findAll(n => isUndescribedImage(n as SceneNode)) as SceneNode[];
  const fresh = targets.filter(n => {
    const id = n.getPluginData('polly_squawk_overlay_id');
    const existing = id ? figma.getNodeById(id) : null;
    return !(existing && !existing.removed);
  });

  let skipped = 0;
  for (const n of fresh) {
    try {
      await createSquawkOverlay(n, false);
    } catch (e) {
      skipped++;
    }
  }
  syncOverlays();

  if (targets.length > 0) {
    const s = targets.length === 1 ? '' : 's';
    figma.notify(`🦜 SQUAWK! ${targets.length} image${s} on this page ${targets.length === 1 ? 'is' : 'are'} missing alt text.${skipped ? ` (${skipped} could not be marked)` : ''}`);
  }
}

async function createScrimOverlay(imgNode: SceneNode, kind: 'squawk' | 'decorative', reveal = true) {
  const b = imgNode.absoluteBoundingBox;
  if (!b) return;
  const isSquawk = kind === 'squawk';
  if (isSquawk) removeSquawkOverlay(imgNode);

  const showTitle = isSquawk ? (b.width >= 90 && b.height >= 40) : (b.width >= 110 && b.height >= 40);
  const showBody = isSquawk && b.width >= 150 && b.height >= 90;
  if (showTitle) {
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
    if (showBody) await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  }

  const overlay = figma.createFrame();
  try {
    overlay.name = isSquawk ? `[Squawk Overlay] ${imgNode.name}` : `[Decorative] ${imgNode.name}`;
    overlay.layoutMode = 'VERTICAL';
    overlay.primaryAxisSizingMode = 'FIXED';
    overlay.counterAxisSizingMode = 'FIXED';
    overlay.resize(Math.max(b.width, 1), Math.max(b.height, 1));
    overlay.primaryAxisAlignItems = 'CENTER';
    overlay.counterAxisAlignItems = 'CENTER';
    overlay.paddingLeft = 12;
    overlay.paddingRight = 12;
    overlay.paddingTop = 12;
    overlay.paddingBottom = 12;
    overlay.itemSpacing = 6;
    overlay.clipsContent = true;

    if ('cornerRadius' in imgNode && typeof (imgNode as any).cornerRadius === 'number') {
      overlay.cornerRadius = (imgNode as any).cornerRadius;
    }

    overlay.fills = [{
      type: 'SOLID',
      color: { r: 0.08, g: 0.09, b: 0.1 },
      opacity: SCRIM_OPACITY
    }];

    const textWidth = Math.max(Math.min(b.width - 24, 280), 40);

    if (showTitle) {
      const title = figma.createText();
      title.fontName = { family: 'Inter', style: 'Bold' };
      title.characters = isSquawk ? '🦜 SQUAWK!' : 'Purely decorative and unimportant';
      title.fontSize = isSquawk ? Math.min(Math.max(b.width * 0.05, 10), 22) : Math.min(Math.max(b.width * 0.045, 10), 20);
      title.fills = [{ type: 'SOLID', color: isSquawk ? { r: 1, g: 0.92, b: 0.6 } : { r: 1, g: 1, b: 1 } }];
      title.textAlignHorizontal = 'CENTER';
      title.resize(textWidth, title.height);
      title.textAutoResize = 'HEIGHT';
      overlay.appendChild(title);
    }

    if (showBody) {
      const msg = figma.createText();
      msg.fontName = { family: 'Inter', style: 'Regular' };
      msg.characters = "Your blind visitors won't know what this is until you give it alt.\nLet Polly help you with that!";
      msg.fontSize = Math.min(Math.max(b.width * 0.035, 10), 14);
      msg.lineHeight = { value: 140, unit: 'PERCENT' };
      msg.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      msg.textAlignHorizontal = 'CENTER';
      msg.resize(textWidth, msg.height);
      msg.textAutoResize = 'HEIGHT';
      overlay.appendChild(msg);
    }

    overlay.setPluginData(isSquawk ? 'polly_is_squawk_overlay' : 'polly_is_deco_overlay', 'true');
    overlay.setPluginData('polly_target_image_id', imgNode.id);
    imgNode.setPluginData(isSquawk ? 'polly_squawk_overlay_id' : 'polly_deco_overlay_id', overlay.id);
  } catch (e) {
    overlay.remove();
    throw e;
  }

  addToAnnotationLayer(overlay, reveal);
  overlay.x = b.x;
  overlay.y = b.y;
}

async function createSquawkOverlay(imgNode: SceneNode, reveal = true) {
  await createScrimOverlay(imgNode, 'squawk', reveal);
}

async function checkAndSquawkNewImage(node: BaseNode) {
  if (!node || node.removed) return;
  if (recentlySquawked.has(node.id)) return;

  if (
    node.getPluginData('polly_is_badge') === 'true' ||
    node.getPluginData('polly_is_margin_card') === 'true' ||
    node.getPluginData('polly_is_guide_line') === 'true' ||
    node.getPluginData('polly_is_squawk_overlay') === 'true'
  ) {
    return;
  }

  let hasImage = false;
  if ('fills' in node && Array.isArray((node as any).fills)) {
    hasImage = (node as any).fills.some((f: Paint) => f.type === 'IMAGE');
  }

  if (hasImage) {
    const existingAlt = node.getPluginData('polly_alt');
    const isDecorative = node.getPluginData('polly_is_decorative') === 'true';

    if (!existingAlt && !isDecorative) {
      recentlySquawked.add(node.id);
      setTimeout(() => recentlySquawked.delete(node.id), 8000);

      // 1. Plant the Squawk Curtain on canvas
      await createSquawkOverlay(node as SceneNode);

      // 2. Focus layer & send data to Polly
      figma.currentPage.selection = [node as SceneNode];
      await new Promise(r => setTimeout(r, 150));
      await sendCurrentSelection();

      // 3. Trigger Polly Green pulsing toast inside plugin
      figma.ui.postMessage({
        type: 'SHOW_SQUAWK_TOAST',
        nodeName: node.name
      });
    }
  }
}

// Listen for layer drag/move events & fresh image drops
figma.on('documentchange', (event) => {
  if (isSelfUpdating) return;

  for (const change of event.documentChanges) {
    if (change.type === 'CREATE') {
      const node = (change as any).node;
      if (node && !node.removed && !isPollyNode(node)) {
        lastCreateAt = Date.now();
        waitForImageFill(node).then(ok => { if (ok) checkAndSquawkNewImage(node); }).catch(e => console.error('Squawk failed', e));
      }
    } else if (change.type === 'PROPERTY_CHANGE') {
      const node = (change as any).node;
      if (!node || node.removed) continue;

      if (!isPollyNode(node) && change.properties.some(p => p === 'x' || p === 'y' || p === 'width' || p === 'height' || p === 'rotation' || p === 'visible')) {
        scheduleOverlaySync();
      }

      if (change.properties.some(p => p === 'x' || p === 'y')) {
        if (node.getPluginData && node.getPluginData('polly_is_margin_card') === 'true') {
          const card = node as FrameNode;
          const imgId = card.getPluginData('polly_source_image_id');
          const imgNode = imgId ? figma.getNodeById(imgId) as SceneNode : null;
          if (imgNode && !imgNode.removed) {
            drawOrUpdateLeaderLine(imgNode, card);
          }
        }
      }

      if (change.properties.includes('fills')) {
        setTimeout(() => checkAndSquawkNewImage(node), 120);
      }
    } else if (change.type === 'DELETE') {
      scheduleOverlaySync();
    }
  }
});

function drawOrUpdateLeaderLine(imgNode: SceneNode, card: FrameNode) {
  if (!imgNode.absoluteBoundingBox || card.removed || imgNode.removed) return;

  const oldLineId = imgNode.getPluginData('polly_margin_line_id');
  if (oldLineId) {
    const oldLine = figma.getNodeById(oldLineId);
    if (oldLine) oldLine.remove();
  }
  const oldHaloId = imgNode.getPluginData('polly_margin_halo_id');
  if (oldHaloId) {
    const oldHalo = figma.getNodeById(oldHaloId);
    if (oldHalo) oldHalo.remove();
  }
  const oldDotId = imgNode.getPluginData('polly_margin_dot_id');
  if (oldDotId) {
    const oldDot = figma.getNodeById(oldDotId);
    if (oldDot) oldDot.remove();
  }

  const imageBounds = imgNode.absoluteBoundingBox;
  const startX = Math.round(imageBounds.x + (imageBounds.width / 2));
  const startY = Math.round(imageBounds.y + (imageBounds.height / 2));

  const isCardOnLeft = (card.x + card.width / 2) < startX;
  const endX = Math.round(isCardOnLeft ? (card.x + card.width) : card.x);
  const endY = Math.round(card.y + 20);

  const dx = Math.round(Math.max(Math.abs(endX - startX) * 0.45, 60));
  const cp1X = isCardOnLeft ? (startX - dx) : (startX + dx);
  const cp2X = isCardOnLeft ? (endX + dx) : (endX - dx);
  const pathData = `M ${startX} ${startY} C ${cp1X} ${startY} ${cp2X} ${endY} ${endX} ${endY}`;

  isSelfUpdating = true;

  const dot = figma.createEllipse();
  dot.name = `[Pin] ${imgNode.name}`;
  dot.resize(8, 8);
  addToAnnotationLayer(dot);
  dot.x = startX - 4;
  dot.y = startY - 4;
  dot.fills = [{ type: 'SOLID', color: { r: 0.03, g: 0.54, b: 0.03 } }];
  dot.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  dot.strokeWeight = 2;
  dot.setPluginData('polly_is_guide_line', 'true');
  imgNode.setPluginData('polly_margin_dot_id', dot.id);

  const halo = figma.createVector();
  halo.name = `[Guide Halo] ${imgNode.name}`;
  halo.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  halo.strokeWeight = 5.5;
  halo.vectorPaths = [{ windingRule: 'NONE', data: pathData }];
  halo.setPluginData('polly_is_guide_line', 'true');
  addToAnnotationLayer(halo);
  imgNode.setPluginData('polly_margin_halo_id', halo.id);

  const line = figma.createVector();
  line.name = `[Guide] ${imgNode.name}`;
  line.strokes = [{ type: 'SOLID', color: { r: 0.03, g: 0.54, b: 0.03 } }];
  line.strokeWeight = 2.5;
  line.dashPattern = [6, 4];
  line.vectorPaths = [{ windingRule: 'NONE', data: pathData }];
  line.setPluginData('polly_is_guide_line', 'true');
  addToAnnotationLayer(line);
  imgNode.setPluginData('polly_margin_line_id', line.id);

  isSelfUpdating = false;
}

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection[0];
  if (focusTargetId && (!sel || (sel.id !== focusTargetId && sel.getPluginData('polly_is_focus_ring') !== 'true'))) {
    clearFocusRing();
  }
  if (sel && Date.now() - lastCreateAt < 3000) {
    waitForImageFill(sel).then(ok => { if (ok) checkAndSquawkNewImage(sel); }).catch(e => console.error('Squawk failed', e));
  }
  sendCurrentSelection();
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'RESIZE_WINDOW') {
    figma.ui.resize(msg.width, msg.height);
    figma.clientStorage.setAsync('polly_window_size', { width: msg.width, height: msg.height }).catch(() => {});
  }

  if (msg.type === 'INIT') {
    const settings = await figma.clientStorage.getAsync('polly_settings');
    figma.ui.postMessage({
      type: 'SETTINGS_LOADED',
      data: settings || {
        apiKey: '',
        model: 'gemini-2.5-flash',
        choiceCount: 3,
        includeExplanation: true
      }
    });
    const layer = findAnnotationLayer();
    figma.ui.postMessage({ type: 'ANNOTATIONS_VISIBLE', visible: layer ? layer.visible : true });
    const storedAdvance = await figma.clientStorage.getAsync('polly_auto_advance');
    autoAdvance = storedAdvance !== false;
    figma.ui.postMessage({ type: 'AUTO_ADVANCE_LOADED', value: autoAdvance });
    sendCurrentSelection();
    squawkAllMissingAlt().then(() => { setStatus(''); sendMissingCount(); }).catch(e => { setStatus(''); console.error('Squawk scan failed', e); });
    runPollyDiagnostic();
  }

  if (msg.type === 'NEXT_MISSING') {
    goToNextMissing().catch(e => console.error('Next image failed', e));
  }

  if (msg.type === 'SET_AUTO_ADVANCE') {
    autoAdvance = !!msg.value;
    figma.clientStorage.setAsync('polly_auto_advance', autoAdvance).catch(() => {});
  }

  if (msg.type === 'SAVE_SETTINGS') {
    await figma.clientStorage.setAsync('polly_settings', msg.data);
    figma.notify('🦜 Polly settings saved!');
  }

  if (msg.type === 'REQUEST_IMAGE_DATA') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;

    const node = selection[0];
    try {
      const bytes = await node.exportAsync({
        format: 'JPG',
        constraint: { type: 'WIDTH', value: 1024 }
      });

      const base64 = uint8ArrayToBase64(bytes);

      figma.ui.postMessage({
        type: 'IMAGE_DATA_READY',
        data: {
          base64,
          mimeType: 'image/jpeg'
        }
      });
    } catch (err: any) {
      figma.ui.postMessage({
        type: 'IMAGE_DATA_ERROR',
        error: err.message || 'Failed to export image bytes from layer.'
      });
    }
  }

  if (msg.type === 'TOGGLE_BADGES') {
    const layer = findAnnotationLayer();
    if (layer) layer.visible = msg.show;
    figma.notify(msg.show ? '🦜 Polly annotations visible' : '🦜 Polly annotations hidden');
  }

  async function pinMarginCallout(node: SceneNode) {
    const altText = node.getPluginData('polly_alt');
    if (!altText) return;

    let rootFrame: BaseNode = node;
    while (rootFrame.parent && rootFrame.parent.type !== 'PAGE') {
      rootFrame = rootFrame.parent;
    }

    const priorNoteId = node.getPluginData('polly_margin_note_id');
    if (priorNoteId) {
      const oldNote = figma.getNodeById(priorNoteId);
      if (oldNote) oldNote.remove();
    }
    const priorLineId = node.getPluginData('polly_margin_line_id');
    if (priorLineId) {
      const oldLine = figma.getNodeById(priorLineId);
      if (oldLine) oldLine.remove();
    }
    const priorHaloId = node.getPluginData('polly_margin_halo_id');
    if (priorHaloId) {
      const oldHalo = figma.getNodeById(priorHaloId);
      if (oldHalo) oldHalo.remove();
    }
    const priorDotId = node.getPluginData('polly_margin_dot_id');
    if (priorDotId) {
      const oldDot = figma.getNodeById(priorDotId);
      if (oldDot) oldDot.remove();
    }

    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

    const card = figma.createFrame();
    card.name = `[A11y Spec] ${node.name}`;
    card.layoutMode = 'VERTICAL';
    card.primaryAxisSizingMode = 'AUTO';
    card.counterAxisSizingMode = 'FIXED';
    card.resize(280, 100);
    card.paddingLeft = 14;
    card.paddingRight = 14;
    card.paddingTop = 12;
    card.paddingBottom = 12;
    card.itemSpacing = 8;
    card.cornerRadius = 6;
    card.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.98, b: 0.94 } }];
    card.strokes = [{ type: 'SOLID', color: { r: 0.03, g: 0.54, b: 0.03 } }];
    card.strokeWeight = 1.5;

    const tag = figma.createText();
    tag.fontName = { family: 'Inter', style: 'Bold' };
    tag.characters = '🦜 ALT TEXT SPEC';
    tag.fontSize = 10;
    tag.fills = [{ type: 'SOLID', color: { r: 0.03, g: 0.54, b: 0.03 } }];
    tag.layoutAlign = 'STRETCH';
    card.appendChild(tag);

    const body = figma.createText();
    body.fontName = { family: 'Inter', style: 'Regular' };
    body.characters = altText;
    body.fontSize = 12;
    body.lineHeight = { value: 17, unit: 'PIXELS' };
    body.fills = [{ type: 'SOLID', color: { r: 0.12, g: 0.16, b: 0.10 } }];
    body.layoutAlign = 'STRETCH';
    body.textAutoResize = 'HEIGHT';
    card.appendChild(body);

    addToAnnotationLayer(card);

    const imageBounds = node.absoluteBoundingBox;
    const rootX = 'x' in rootFrame ? (rootFrame as any).x : 0;
    const rootWidth = 'width' in rootFrame ? (rootFrame as any).width : 1200;
    const cardWidth = 280;
    const targetY_ideal = imageBounds ? imageBounds.y : ('y' in rootFrame ? (rootFrame as any).y : 0);

    let rightObstacleDist = Infinity;
    let leftObstacleDist = Infinity;

    for (const child of figma.currentPage.children) {
      if (child.id === rootFrame.id || !('x' in child) || !('width' in child)) continue;
      if (child.getPluginData('polly_is_margin_card') === 'true' || child.getPluginData('polly_is_guide_line') === 'true' || child.getPluginData('polly_is_annotation_layer') === 'true') continue;

      const childX = (child as any).x;
      const childY = (child as any).y;
      const childW = (child as any).width;
      const childH = (child as any).height || 1000;

      const yOverlap = (childY < targetY_ideal + 300) && (childY + childH > targetY_ideal - 100);
      if (!yOverlap) continue;

      if (childX >= rootX + rootWidth - 20) {
        const dist = childX - (rootX + rootWidth);
        if (dist < rightObstacleDist) rightObstacleDist = dist;
      }

      if (childX + childW <= rootX + 20) {
        const dist = rootX - (childX + childW);
        if (dist < leftObstacleDist) leftObstacleDist = dist;
      }
    }

    const placeOnLeft = (rightObstacleDist < cardWidth + 80) && (leftObstacleDist > rightObstacleDist);
    const targetX = placeOnLeft ? (rootX - cardWidth - 60) : (rootX + rootWidth + 60);

    let targetY = targetY_ideal;

    const existingCards = figma.currentPage.findAll(n =>
      n.id !== card.id &&
      n.getPluginData('polly_is_margin_card') === 'true' &&
      Math.abs(n.x - targetX) < 100
    ) as FrameNode[];

    existingCards.sort((a, b) => a.y - b.y);

    let hasCollision = true;
    while (hasCollision) {
      hasCollision = false;
      for (const ec of existingCards) {
        const ecTop = ec.y;
        const ecBottom = ec.y + ec.height + 40;
        if (targetY >= ecTop - 30 && targetY < ecBottom) {
          targetY = ecBottom;
          hasCollision = true;
          break;
        }
      }
    }

    card.x = targetX;
    card.y = targetY;
    card.setPluginData('polly_is_margin_card', 'true');
    card.setPluginData('polly_source_image_id', node.id);

    drawOrUpdateLeaderLine(node, card);

    node.setPluginData('polly_margin_note_id', card.id);
  }

  if (msg.type === 'CLEAR_DECORATIVE') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;

    const node = selection[0];
    clearPollyAnnotations(node);
    node.setPluginData('polly_is_decorative', 'false');

    if ('annotations' in node) {
      node.annotations = node.annotations.filter(a => !(a.labelMarkdown || '').startsWith('**Accessibility'));
    }

    checkAndSquawkNewImage(node);
    sendCurrentSelection();
    scheduleOverlaySync();
  }

  if (msg.type === 'APPLY_ALT_TEXT') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;

    const node = selection[0];
    const { altText, isDecorative, explanation } = msg.data;

    // Remove the Squawk Curtain now that the image is described
    removeSquawkOverlay(node);

    node.setPluginData('polly_alt', isDecorative ? '' : altText);
    node.setPluginData('polly_is_decorative', isDecorative ? 'true' : 'false');

    if ('annotations' in node) {
      const markdown = isDecorative
        ? `**Accessibility:** Marked as **Decorative**`
        : `**Accessibility (Alt Text):**\n\`\`\`text\n${altText}\n\`\`\`${explanation ? `\n\n*Rationale:* ${explanation}` : ''}`;

      node.annotations = [{ labelMarkdown: markdown }];
    }

    clearPollyAnnotations(node);

    if (isDecorative) {
      await createDecorativeOverlay(node);
    } else if (altText) {
      await pinMarginCallout(node);
    }

    figma.notify(isDecorative ? '🦜 Marked decorative' : '🦜 Alt text saved & pinned to the canvas!');
    sendCurrentSelection();

    if (autoAdvance) {
      const doneId = node.id;
      clearTimeout(advanceTimer);
      setStatus('🦜 Saved! Moving to the next image…');
      advanceTimer = setTimeout(() => {
        setStatus('');
        const cur = figma.currentPage.selection[0];
        if (cur && cur.id === doneId) {
          goToNextMissing().catch(e => console.error('Next image failed', e));
        } else {
          sendMissingCount();
        }
      }, 1500);
    } else {
      scheduleOverlaySync();
    }
  }
};
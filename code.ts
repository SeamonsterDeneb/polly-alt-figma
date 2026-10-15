/// <reference types="@figma/plugin-typings" />

// Polly Alt - Figma Canvas Engine
figma.showUI(__html__, {
  width: 440,
  height: 620,
  themeColors: true
});

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

  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE') {
    if (current.type === 'FRAME' || current.type === 'SECTION' || current.type === 'COMPONENT') {
      context.frameName = current.name;
      break;
    }
    current = current.parent;
  }

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

  if (node.parent && 'children' in node.parent) {
    const textNodes: TextNode[] = [];
    for (const child of node.parent.children) {
      if (child.type === 'TEXT' && child.characters && child.characters.trim().length > 10) {
        textNodes.push(child);
      }
    }

    textNodes.sort((a, b) => a.y - b.y);

    const beforeTexts: string[] = [];
    const afterTexts: string[] = [];

    for (const t of textNodes) {
      const text = t.characters.trim();
      if (t.y + t.height <= node.y + 15) {
        beforeTexts.push(text);
      } else if (t.y >= node.y + node.height - 15) {
        afterTexts.push(text);
      }
    }

    if (beforeTexts.length > 0) context.paragraphsBefore = beforeTexts.slice(-2).join('\n\n');
    if (afterTexts.length > 0) context.paragraphsAfter = afterTexts.slice(0, 2).join('\n\n');
  }

  return context;
}

async function sendCurrentSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'SELECTION_CLEARED' });
    return;
  }

  const node = selection[0];
  let hasImage = false;

  if ('fills' in node && Array.isArray(node.fills)) {
    hasImage = node.fills.some(f => f.type === 'IMAGE');
  }

  if (!hasImage && (node.type === 'FRAME' || node.type === 'RECTANGLE' || node.type === 'INSTANCE' || node.type === 'COMPONENT')) {
    hasImage = true;
  }

  let previewBase64 = '';
  if (hasImage) {
    try {
      const previewBytes = await node.exportAsync({
        format: 'JPG',
        constraint: { type: 'WIDTH', value: 800 }
      });
      previewBase64 = uint8ArrayToBase64(previewBytes);
    } catch (e) {
      // Ignore preview export error
    }
  }

  const existingAlt = node.getPluginData('polly_alt') || '';
  const isDecorative = node.getPluginData('polly_is_decorative') === 'true';
  const context = extractNodeContext(node);

  figma.ui.postMessage({
    type: 'SELECTION_READY',
    data: {
      nodeId: node.id,
      nodeName: node.name,
      hasImage,
      existingAlt,
      isDecorative,
      context,
      previewBase64
    }
  });
}

let isSelfUpdating = false;

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
  figma.currentPage.appendChild(dot);
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
  figma.currentPage.appendChild(halo);
  imgNode.setPluginData('polly_margin_halo_id', halo.id);

  const line = figma.createVector();
  line.name = `[Guide] ${imgNode.name}`;
  line.strokes = [{ type: 'SOLID', color: { r: 0.03, g: 0.54, b: 0.03 } }];
  line.strokeWeight = 2.5;
  line.dashPattern = [6, 4];
  line.vectorPaths = [{ windingRule: 'NONE', data: pathData }];
  line.setPluginData('polly_is_guide_line', 'true');
  figma.currentPage.appendChild(line);
  imgNode.setPluginData('polly_margin_line_id', line.id);

  isSelfUpdating = false;
}

figma.on('selectionchange', sendCurrentSelection);

figma.on('documentchange', (event) => {
  if (isSelfUpdating) return;

  for (const change of event.documentChanges) {
    if (change.type === 'PROPERTY_CHANGE') {
      const node = (change as any).node;
      if (!node || node.removed) continue;

      if (node.getPluginData && node.getPluginData('polly_is_margin_card') === 'true') {
        const card = node as FrameNode;
        const imgId = card.getPluginData('polly_source_image_id');
        const imgNode = imgId ? figma.getNodeById(imgId) as SceneNode : null;
        if (imgNode && !imgNode.removed) {
          drawOrUpdateLeaderLine(imgNode, card);
        }
      }
    }
  }
});

figma.ui.onmessage = async (msg) => {
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
    sendCurrentSelection();
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
    const show = msg.show;
    const badges = figma.currentPage.findAll(n => n.getPluginData('polly_is_badge') === 'true');
    for (const b of badges) {
      b.visible = show;
    }
    figma.notify(show ? '🦜 Alt badges visible' : '🦜 Alt badges hidden for presentation');
  }

  if (msg.type === 'PIN_MARGIN_CALLOUT') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;

    const node = selection[0];
    const altText = node.getPluginData('polly_alt');
    if (!altText) {
      figma.notify('🦜 No alt text saved on this layer yet.');
      return;
    }

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

    figma.currentPage.appendChild(card);

    const imageBounds = node.absoluteBoundingBox;
    const rootX = 'x' in rootFrame ? (rootFrame as any).x : 0;
    const rootWidth = 'width' in rootFrame ? (rootFrame as any).width : 1200;
    const cardWidth = 280;
    const targetY_ideal = imageBounds ? imageBounds.y : ('y' in rootFrame ? (rootFrame as any).y : 0);

    let rightObstacleDist = Infinity;
    let leftObstacleDist = Infinity;

    for (const child of figma.currentPage.children) {
      if (child.id === rootFrame.id || !('x' in child) || !('width' in child)) continue;
      if (child.getPluginData('polly_is_margin_card') === 'true' || child.getPluginData('polly_is_guide_line') === 'true') continue;

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
    figma.notify(placeOnLeft ? '🦜 Pinned alt card to the left margin!' : '🦜 Pinned alt card to the right margin!');
  }

  if (msg.type === 'APPLY_ALT_TEXT') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;

    const node = selection[0];
    const { altText, isDecorative, explanation } = msg.data;

    node.setPluginData('polly_alt', isDecorative ? '' : altText);
    node.setPluginData('polly_is_decorative', isDecorative ? 'true' : 'false');

    if ('annotations' in node) {
      const markdown = isDecorative
        ? `**Accessibility:** Marked as **Decorative**`
        : `**Accessibility (Alt Text):**\n\`\`\`text\n${altText}\n\`\`\`${explanation ? `\n\n*Rationale:* ${explanation}` : ''}`;

      node.annotations = [{ labelMarkdown: markdown }];
    }

    if (!isDecorative && altText) {
      const priorBadgeId = node.getPluginData('polly_badge_id');
      if (priorBadgeId) {
        const oldBadge = figma.getNodeById(priorBadgeId);
        if (oldBadge) oldBadge.remove();
      }

      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

      const badge = figma.createFrame();
      badge.name = `[Polly Alt] ${node.name}`;
      badge.layoutMode = 'VERTICAL';
      badge.paddingLeft = 8;
      badge.paddingRight = 8;
      badge.paddingTop = 6;
      badge.paddingBottom = 6;
      badge.itemSpacing = 4;
      badge.cornerRadius = 4;
      badge.fills = [{ type: 'SOLID', color: { r: 0.94, g: 0.96, b: 0.98 } }];
      badge.strokes = [{ type: 'SOLID', color: { r: 0.13, g: 0.44, b: 0.69 } }];
      badge.strokeWeight = 1;

      if ('layoutPositioning' in badge) {
        badge.layoutPositioning = 'ABSOLUTE';
      }

      badge.setPluginData('polly_is_badge', 'true');

      const tagText = figma.createText();
      tagText.fontName = { family: 'Inter', style: 'Bold' };
      tagText.characters = '🦜 ALT TEXT';
      tagText.fontSize = 9;
      tagText.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.44, b: 0.69 } }];
      badge.appendChild(tagText);

      const bodyText = figma.createText();
      bodyText.fontName = { family: 'Inter', style: 'Regular' };
      bodyText.characters = altText;
      bodyText.fontSize = 11;
      bodyText.fills = [{ type: 'SOLID', color: { r: 0.11, g: 0.13, b: 0.15 } }];
      bodyText.resize(Math.min(node.width, 320), bodyText.height);
      bodyText.textAutoResize = 'HEIGHT';
      badge.appendChild(bodyText);

      if (node.parent && 'appendChild' in node.parent) {
        node.parent.appendChild(badge);
        badge.x = node.x;
        badge.y = node.y + node.height + 8;
      }

      node.setPluginData('polly_badge_id', badge.id);
    }

    figma.notify('🦜 Alt text saved to layer & added to canvas!');
    sendCurrentSelection();
  }
};
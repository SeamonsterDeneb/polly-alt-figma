"use strict";
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
}).catch(() => { });
function uint8ArrayToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return figma.base64Encode(bytes);
}
function extractNodeContext(node) {
    const context = {
        frameName: '',
        isFunctional: false,
        functionalRole: '',
        destination: '',
        destinationTitle: '',
        paragraphsBefore: '',
        paragraphsAfter: ''
    };
    let current = node.parent;
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
                }
                else if (reaction.action.type === 'NODE' && reaction.action.destinationId) {
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
        }
        else if (combinedNames.includes('link') || combinedNames.includes('nav')) {
            context.isFunctional = true;
            context.functionalRole = 'link';
            context.destination = node.name;
        }
    }
    if (node.parent && 'children' in node.parent) {
        const textNodes = [];
        for (const child of node.parent.children) {
            if (child.type === 'TEXT' && child.characters && child.characters.trim().length > 10) {
                textNodes.push(child);
            }
        }
        textNodes.sort((a, b) => a.y - b.y);
        const beforeTexts = [];
        const afterTexts = [];
        for (const t of textNodes) {
            const text = t.characters.trim();
            if (t.y + t.height <= node.y + 15) {
                beforeTexts.push(text);
            }
            else if (t.y >= node.y + node.height - 15) {
                afterTexts.push(text);
            }
        }
        if (beforeTexts.length > 0)
            context.paragraphsBefore = beforeTexts.slice(-2).join('\n\n');
        if (afterTexts.length > 0)
            context.paragraphsAfter = afterTexts.slice(0, 2).join('\n\n');
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
    if (node.getPluginData('polly_is_squawk_overlay') === 'true' || node.getPluginData('polly_is_deco_overlay') === 'true') {
        const targetId = node.getPluginData('polly_target_image_id');
        const realImageNode = targetId ? figma.getNodeById(targetId) : null;
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
                if (previewBase64)
                    break;
            }
            catch (e) {
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
const recentlySquawked = new Set();
let lastCreateAt = 0;
async function waitForImageFill(node, tries = 12) {
    for (let i = 0; i < tries; i++) {
        if (node.removed || !('fills' in node))
            return false;
        if ('fills' in node && Array.isArray(node.fills) && node.fills.some((f) => f.type === 'IMAGE'))
            return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}
function findAnnotationLayer() {
    const layer = figma.currentPage.children.find(n => n.getPluginData('polly_is_annotation_layer') === 'true');
    return layer && layer.type === 'GROUP' ? layer : null;
}
function addToAnnotationLayer(node) {
    let layer = findAnnotationLayer();
    if (!layer) {
        layer = figma.group([node], figma.currentPage);
        layer.name = '🦜 Polly Alt Annotations';
        layer.setPluginData('polly_is_annotation_layer', 'true');
        figma.ui.postMessage({ type: 'ANNOTATIONS_VISIBLE', visible: true });
    }
    else {
        layer.appendChild(node);
        if (!layer.visible) {
            layer.visible = true;
            figma.ui.postMessage({ type: 'ANNOTATIONS_VISIBLE', visible: true });
        }
    }
    const pageChildren = figma.currentPage.children;
    if (pageChildren[pageChildren.length - 1] !== layer)
        figma.currentPage.appendChild(layer);
}
function clearPollyAnnotations(node) {
    const keys = ['polly_margin_note_id', 'polly_margin_line_id', 'polly_margin_halo_id', 'polly_margin_dot_id', 'polly_deco_overlay_id', 'polly_badge_id'];
    for (const key of keys) {
        const id = node.getPluginData(key);
        if (!id)
            continue;
        const target = figma.getNodeById(id);
        if (target && !target.removed)
            target.remove();
        node.setPluginData(key, '');
    }
}
async function createDecorativeOverlay(imgNode) {
    const b = imgNode.absoluteBoundingBox;
    if (!b)
        return;
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
    const overlay = figma.createFrame();
    overlay.name = `[Decorative] ${imgNode.name}`;
    overlay.layoutMode = 'VERTICAL';
    overlay.primaryAxisSizingMode = 'FIXED';
    overlay.counterAxisSizingMode = 'FIXED';
    overlay.resize(Math.max(b.width, 160), Math.max(b.height, 60));
    overlay.primaryAxisAlignItems = 'CENTER';
    overlay.counterAxisAlignItems = 'CENTER';
    overlay.paddingLeft = 16;
    overlay.paddingRight = 16;
    overlay.paddingTop = 16;
    overlay.paddingBottom = 16;
    if ('cornerRadius' in imgNode && typeof imgNode.cornerRadius === 'number') {
        overlay.cornerRadius = imgNode.cornerRadius;
    }
    overlay.fills = [{
            type: 'SOLID',
            color: { r: 0.2, g: 0.22, b: 0.25 },
            opacity: 0.8
        }];
    const label = figma.createText();
    label.fontName = { family: 'Inter', style: 'Bold' };
    label.characters = 'Purely decorative and unimportant';
    label.fontSize = Math.min(Math.max(b.width * 0.045, 11), 20);
    label.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    label.textAlignHorizontal = 'CENTER';
    label.resize(Math.max(Math.min(b.width - 32, 280), 60), label.height);
    label.textAutoResize = 'HEIGHT';
    overlay.appendChild(label);
    overlay.setPluginData('polly_is_deco_overlay', 'true');
    overlay.setPluginData('polly_target_image_id', imgNode.id);
    imgNode.setPluginData('polly_deco_overlay_id', overlay.id);
    addToAnnotationLayer(overlay);
    overlay.x = b.x;
    overlay.y = b.y;
}
// Helper: Remove any squawk overlay attached to an image
function removeSquawkOverlay(imgNode) {
    const overlayId = imgNode.getPluginData('polly_squawk_overlay_id');
    if (overlayId) {
        const overlay = figma.getNodeById(overlayId);
        if (overlay && !overlay.removed) {
            overlay.remove();
        }
        imgNode.setPluginData('polly_squawk_overlay_id', '');
    }
}
// Helper: Create the dimming Squawk Curtain on the image
async function createSquawkOverlay(imgNode) {
    if (!imgNode.parent || !('appendChild' in imgNode.parent))
        return;
    removeSquawkOverlay(imgNode);
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const overlay = figma.createFrame();
    overlay.name = `[Squawk Overlay] ${imgNode.name}`;
    overlay.resize(Math.max(imgNode.width, 160), Math.max(imgNode.height, 120));
    if ('cornerRadius' in imgNode && typeof imgNode.cornerRadius === 'number') {
        overlay.cornerRadius = imgNode.cornerRadius;
    }
    // 75% dark scrim fill
    overlay.fills = [{
            type: 'SOLID',
            color: { r: 0.08, g: 0.09, b: 0.1 },
            opacity: 0.82
        }];
    overlay.layoutMode = 'VERTICAL';
    overlay.primaryAxisSizingMode = 'FIXED';
    overlay.counterAxisSizingMode = 'FIXED';
    overlay.resize(Math.max(imgNode.width, 160), Math.max(imgNode.height, 120));
    overlay.primaryAxisAlignItems = 'CENTER';
    overlay.counterAxisAlignItems = 'CENTER';
    overlay.paddingLeft = 16;
    overlay.paddingRight = 16;
    overlay.paddingTop = 16;
    overlay.paddingBottom = 16;
    overlay.itemSpacing = 8;
    // Squawk Header
    const title = figma.createText();
    title.fontName = { family: 'Inter', style: 'Bold' };
    title.characters = '🦜 SQUAWK!';
    title.fontSize = Math.min(Math.max(imgNode.width * 0.05, 12), 22);
    title.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.8, b: 0.2 } }]; // Gold amber
    title.textAlignHorizontal = 'CENTER';
    overlay.appendChild(title);
    // Benevolent Friction Body
    const msg = figma.createText();
    msg.fontName = { family: 'Inter', style: 'Regular' };
    msg.characters = "Your blind visitors won't know what this is until you give it alt.\nLet Polly help you with that!";
    msg.fontSize = Math.min(Math.max(imgNode.width * 0.035, 10), 14);
    msg.lineHeight = { value: 140, unit: 'PERCENT' };
    msg.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    msg.textAlignHorizontal = 'CENTER';
    msg.resize(Math.min(imgNode.width - 32, 280), msg.height);
    msg.textAutoResize = 'HEIGHT';
    overlay.appendChild(msg);
    // Link metadata so clicking overlay redirects to image
    overlay.setPluginData('polly_is_squawk_overlay', 'true');
    overlay.setPluginData('polly_target_image_id', imgNode.id);
    imgNode.setPluginData('polly_squawk_overlay_id', overlay.id);
    imgNode.parent.appendChild(overlay);
    if ('layoutMode' in imgNode.parent && imgNode.parent.layoutMode !== 'NONE' && 'layoutPositioning' in overlay) {
        overlay.layoutPositioning = 'ABSOLUTE';
    }
    overlay.x = imgNode.x;
    overlay.y = imgNode.y;
}
async function checkAndSquawkNewImage(node) {
    if (!node || node.removed)
        return;
    if (recentlySquawked.has(node.id))
        return;
    if (node.getPluginData('polly_is_badge') === 'true' ||
        node.getPluginData('polly_is_margin_card') === 'true' ||
        node.getPluginData('polly_is_guide_line') === 'true' ||
        node.getPluginData('polly_is_squawk_overlay') === 'true') {
        return;
    }
    let hasImage = false;
    if ('fills' in node && Array.isArray(node.fills)) {
        hasImage = node.fills.some((f) => f.type === 'IMAGE');
    }
    if (hasImage) {
        const existingAlt = node.getPluginData('polly_alt');
        const isDecorative = node.getPluginData('polly_is_decorative') === 'true';
        if (!existingAlt && !isDecorative) {
            recentlySquawked.add(node.id);
            setTimeout(() => recentlySquawked.delete(node.id), 8000);
            // 1. Plant the Squawk Curtain on canvas
            await createSquawkOverlay(node);
            // 2. Focus layer & send data to Polly
            figma.currentPage.selection = [node];
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
    if (isSelfUpdating)
        return;
    for (const change of event.documentChanges) {
        if (change.type === 'CREATE') {
            const node = change.node;
            if (node && !node.removed) {
                lastCreateAt = Date.now();
                waitForImageFill(node).then(ok => { if (ok)
                    checkAndSquawkNewImage(node); }).catch(e => console.error('Squawk failed', e));
            }
        }
        else if (change.type === 'PROPERTY_CHANGE') {
            const node = change.node;
            if (!node || node.removed)
                continue;
            if (change.properties.some(p => p === 'x' || p === 'y')) {
                if (node.getPluginData && node.getPluginData('polly_is_margin_card') === 'true') {
                    const card = node;
                    const imgId = card.getPluginData('polly_source_image_id');
                    const imgNode = imgId ? figma.getNodeById(imgId) : null;
                    if (imgNode && !imgNode.removed) {
                        drawOrUpdateLeaderLine(imgNode, card);
                    }
                }
            }
            if (change.properties.includes('fills')) {
                setTimeout(() => checkAndSquawkNewImage(node), 120);
            }
        }
    }
});
function drawOrUpdateLeaderLine(imgNode, card) {
    if (!imgNode.absoluteBoundingBox || card.removed || imgNode.removed)
        return;
    const oldLineId = imgNode.getPluginData('polly_margin_line_id');
    if (oldLineId) {
        const oldLine = figma.getNodeById(oldLineId);
        if (oldLine)
            oldLine.remove();
    }
    const oldHaloId = imgNode.getPluginData('polly_margin_halo_id');
    if (oldHaloId) {
        const oldHalo = figma.getNodeById(oldHaloId);
        if (oldHalo)
            oldHalo.remove();
    }
    const oldDotId = imgNode.getPluginData('polly_margin_dot_id');
    if (oldDotId) {
        const oldDot = figma.getNodeById(oldDotId);
        if (oldDot)
            oldDot.remove();
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
    if (sel && Date.now() - lastCreateAt < 3000) {
        waitForImageFill(sel).then(ok => { if (ok)
            checkAndSquawkNewImage(sel); }).catch(e => console.error('Squawk failed', e));
    }
    sendCurrentSelection();
});
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'RESIZE_WINDOW') {
        figma.ui.resize(msg.width, msg.height);
        figma.clientStorage.setAsync('polly_window_size', { width: msg.width, height: msg.height }).catch(() => { });
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
        sendCurrentSelection();
    }
    if (msg.type === 'SAVE_SETTINGS') {
        await figma.clientStorage.setAsync('polly_settings', msg.data);
        figma.notify('🦜 Polly settings saved!');
    }
    if (msg.type === 'REQUEST_IMAGE_DATA') {
        const selection = figma.currentPage.selection;
        if (selection.length === 0)
            return;
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
        }
        catch (err) {
            figma.ui.postMessage({
                type: 'IMAGE_DATA_ERROR',
                error: err.message || 'Failed to export image bytes from layer.'
            });
        }
    }
    if (msg.type === 'TOGGLE_BADGES') {
        const layer = findAnnotationLayer();
        if (layer)
            layer.visible = msg.show;
        figma.notify(msg.show ? '🦜 Polly annotations visible' : '🦜 Polly annotations hidden');
    }
    async function pinMarginCallout(node) {
        const altText = node.getPluginData('polly_alt');
        if (!altText)
            return;
        let rootFrame = node;
        while (rootFrame.parent && rootFrame.parent.type !== 'PAGE') {
            rootFrame = rootFrame.parent;
        }
        const priorNoteId = node.getPluginData('polly_margin_note_id');
        if (priorNoteId) {
            const oldNote = figma.getNodeById(priorNoteId);
            if (oldNote)
                oldNote.remove();
        }
        const priorLineId = node.getPluginData('polly_margin_line_id');
        if (priorLineId) {
            const oldLine = figma.getNodeById(priorLineId);
            if (oldLine)
                oldLine.remove();
        }
        const priorHaloId = node.getPluginData('polly_margin_halo_id');
        if (priorHaloId) {
            const oldHalo = figma.getNodeById(priorHaloId);
            if (oldHalo)
                oldHalo.remove();
        }
        const priorDotId = node.getPluginData('polly_margin_dot_id');
        if (priorDotId) {
            const oldDot = figma.getNodeById(priorDotId);
            if (oldDot)
                oldDot.remove();
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
        const rootX = 'x' in rootFrame ? rootFrame.x : 0;
        const rootWidth = 'width' in rootFrame ? rootFrame.width : 1200;
        const cardWidth = 280;
        const targetY_ideal = imageBounds ? imageBounds.y : ('y' in rootFrame ? rootFrame.y : 0);
        let rightObstacleDist = Infinity;
        let leftObstacleDist = Infinity;
        for (const child of figma.currentPage.children) {
            if (child.id === rootFrame.id || !('x' in child) || !('width' in child))
                continue;
            if (child.getPluginData('polly_is_margin_card') === 'true' || child.getPluginData('polly_is_guide_line') === 'true' || child.getPluginData('polly_is_annotation_layer') === 'true')
                continue;
            const childX = child.x;
            const childY = child.y;
            const childW = child.width;
            const childH = child.height || 1000;
            const yOverlap = (childY < targetY_ideal + 300) && (childY + childH > targetY_ideal - 100);
            if (!yOverlap)
                continue;
            if (childX >= rootX + rootWidth - 20) {
                const dist = childX - (rootX + rootWidth);
                if (dist < rightObstacleDist)
                    rightObstacleDist = dist;
            }
            if (childX + childW <= rootX + 20) {
                const dist = rootX - (childX + childW);
                if (dist < leftObstacleDist)
                    leftObstacleDist = dist;
            }
        }
        const placeOnLeft = (rightObstacleDist < cardWidth + 80) && (leftObstacleDist > rightObstacleDist);
        const targetX = placeOnLeft ? (rootX - cardWidth - 60) : (rootX + rootWidth + 60);
        let targetY = targetY_ideal;
        const existingCards = figma.currentPage.findAll(n => n.id !== card.id &&
            n.getPluginData('polly_is_margin_card') === 'true' &&
            Math.abs(n.x - targetX) < 100);
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
        if (selection.length === 0)
            return;
        const node = selection[0];
        clearPollyAnnotations(node);
        node.setPluginData('polly_is_decorative', 'false');
        if ('annotations' in node) {
            node.annotations = node.annotations.filter(a => !(a.labelMarkdown || '').startsWith('**Accessibility'));
        }
        checkAndSquawkNewImage(node);
        sendCurrentSelection();
    }
    if (msg.type === 'APPLY_ALT_TEXT') {
        const selection = figma.currentPage.selection;
        if (selection.length === 0)
            return;
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
        if (!isDecorative && altText) {
            const priorBadgeId = node.getPluginData('polly_badge_id');
            if (priorBadgeId) {
                const oldBadge = figma.getNodeById(priorBadgeId);
                if (oldBadge)
                    oldBadge.remove();
            }
        }
        if (!isDecorative && altText)
            await pinMarginCallout(node);
        figma.notify('🦜 Alt text saved & pinned to the canvas!');
        sendCurrentSelection();
    }
};

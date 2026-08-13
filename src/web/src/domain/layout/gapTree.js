/**
 * GapTree — analisi layout verticale e raggruppamento di righe testuali.
 *
 * Implementazione dell'algoritmo GapTree:
 * - Raggruppa box detection in nodi basati su gap orizzontali tra righe
 * - Costruisce un albero di layout
 * - Ogni nodo viene fuso in una regione tramite unionBoxes
 */
import { unionBoxes, mergeVerticalTouchingBlocks } from '../geometry.js';
import { MERGE_VERTICAL_TOUCHING } from '../../config/pipeline.js';

/* ─── GapTree class ─── */

class GapTree {
  constructor(getBBox) {
    this.getBBox = getBBox;
    this.currentRows = [];
    this.currentCuts = [];
    this.currentNodes = [];
  }

  sort(textBlocks) {
    const [units, pageL, pageR] = this._getUnits(textBlocks, this.getBBox);
    if (!units.length) {
      // Nessun unit valido (input vuoto o tutti i box scartati): albero vuoto.
      this.currentRows = [];
      this.currentCuts = [];
      this.currentNodes = [];
      return [];
    }
    const [cuts, rows] = this._getCutsRows(units, pageL, pageR);
    const root = this._getLayoutTree(cuts, rows);
    const nodes = this._preorderTraversal(root);
    const newTextBlocks = this._getTextBlocks(nodes);

    this.currentRows = rows;
    this.currentCuts = cuts;
    this.currentNodes = nodes;

    return newTextBlocks;
  }

  getNodesTextBlocks() {
    const result = [];
    for (const node of this.currentNodes) {
      const tbs = [];
      if (node.units && node.units.length) {
        for (const unit of node.units) {
          tbs.push(unit[1]);
        }
        result.push(tbs);
      }
    }
    return result;
  }

  _getUnits(textBlocks, getBBox) {
    const units = [];
    let pageL = Infinity;
    let pageR = -1;

    for (const tb of textBlocks) {
      const [x0, y0, x1, y1] = getBBox(tb);
      // Box malformati (NaN/Infinity, larghezza o altezza non positive)
      // corromperebbero pageL/pageR, i gap e i cut: si scartano.
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      if (x1 <= x0 || y1 <= y0) continue;
      units.push([[x0, y0, x1, y1], tb]);
      if (x0 < pageL) pageL = x0;
      if (x1 > pageR) pageR = x1;
    }

    units.sort((a, b) => a[0][1] - b[0][1]);
    return [units, pageL, pageR];
  }

  _getCutsRows(units, pageL, pageR) {
    const updateGaps = (gaps1, gaps2) => {
      const flags1 = gaps1.map(() => true);
      const flags2 = gaps2.map(() => true);
      const newGaps1 = [];

      for (let i1 = 0; i1 < gaps1.length; i1++) {
        const [l1, r1, rowStart1] = gaps1[i1];
        for (let i2 = 0; i2 < gaps2.length; i2++) {
          const [l2, r2] = gaps2[i2];
          const interL = Math.max(l1, l2);
          const interR = Math.min(r1, r2);

          if (interL <= interR) {
            newGaps1.push([interL, interR, rowStart1]);
            flags1[i1] = false;
            flags2[i2] = false;
          }
        }
      }

      for (let i2 = 0; i2 < flags2.length; i2++) {
        if (flags2[i2]) newGaps1.push(gaps2[i2]);
      }

      const delGaps1 = [];
      for (let i1 = 0; i1 < flags1.length; i1++) {
        if (flags1[i1]) delGaps1.push(gaps1[i1]);
      }

      return [newGaps1, delGaps1];
    };

    pageL -= 1;
    pageR += 1;

    const rows = [];
    const completedCuts = [];
    let gaps = [];

    let rowIndex = 0;
    let unitIndex = 0;
    const totalUnits = units.length;

    while (unitIndex < totalUnits) {
      const unit = units[unitIndex];
      const uBottom = unit[0][3];
      const row = [unit];

      for (let i = unitIndex + 1; i < units.length; i++) {
        const nextU = units[i];
        const nextTop = nextU[0][1];
        if (nextTop > uBottom) break;
        row.push(nextU);
        unitIndex = i;
      }

      row.sort((a, b) => {
        if (a[0][0] !== b[0][0]) return a[0][0] - b[0][0];
        return a[0][2] - b[0][2];
      });

      const rowGaps = [];
      let searchStart = pageL;

      for (const u of row) {
        const l = u[0][0];
        const r = u[0][2];
        if (l > searchStart) {
          rowGaps.push([searchStart, l, rowIndex]);
          searchStart = r;
        } else if (l < searchStart) {
          const overlap = searchStart - l;
          if (overlap < 30) {
            const pad = Math.round(overlap * 0.5);
            const gapStart = Math.max(pageL, l - pad);
            rowGaps.push([gapStart, searchStart, rowIndex]);
          }
          if (r > searchStart) {
            searchStart = r;
          }
        } else {
          if (r > searchStart) {
            searchStart = r;
          }
        }
      }

      rowGaps.push([searchStart, pageR, rowIndex]);

      let delGaps;
      [gaps, delGaps] = updateGaps(gaps, rowGaps);

      const rowMax = rowIndex - 1;
      for (const dg1 of delGaps) {
        completedCuts.push([...dg1, rowMax]);
      }

      rows.push(row);
      unitIndex += 1;
      rowIndex += 1;
    }

    const rowMax = rows.length - 1;
    for (const g of gaps) {
      completedCuts.push([...g, rowMax]);
    }

    completedCuts.sort((a, b) => a[0] - b[0]);
    return [completedCuts, rows];
  }

  _getLayoutTree(cuts, rows) {
    const rowsGaps = rows.map(() => []);

    for (const cut of cuts) {
      for (let r = cut[2]; r <= cut[3]; r++) {
        rowsGaps[r].push([cut[0], cut[1]]);
      }
    }

    const root = {
      x_left: cuts[0][0] - 1,
      x_right: cuts[cuts.length - 1][1] + 1,
      r_top: -1,
      r_bottom: -1,
      units: [],
      children: [],
    };

    const completedNodes = [root];
    let nowNodes = [];

    const complete = (node) => {
      const nodeR = node.x_right - 2;
      let maxNodes = [];
      let maxR = -2;

      for (const comNode of completedNodes) {
        if (nodeR < comNode.x_left || nodeR > comNode.x_right + 0.0001) {
          continue;
        }
        if (comNode.r_bottom >= node.r_top) {
          continue;
        }
        if (comNode.r_bottom > maxR) {
          maxR = comNode.r_bottom;
          maxNodes = [comNode];
          continue;
        }
        if (comNode.r_bottom === maxR) {
          maxNodes.push(comNode);
        }
      }

      const parent = maxNodes.reduce((best, n) => {
        if (!best || n.x_right > best.x_right) return n;
        return best;
      }, null);

      parent.children.push(node);
      completedNodes.push(node);
    };

    for (let rI = 0; rI < rows.length; rI++) {
      const row = rows[rI];
      const rowGaps = rowsGaps[rI];
      let uI = 0;
      let gI = 0;

      const newNodes = [];
      for (const node of nowNodes) {
        let lFlag = false;
        let rFlag = false;
        let completedFlag = false;
        const xLeft = node.x_left;
        const xRight = node.x_right;

        for (const gap of rowGaps) {
          if (gap[1] === xLeft) lFlag = true;
          if (gap[0] === xRight) rFlag = true;
          if ((xLeft < gap[0] && gap[0] < xRight) || (xLeft < gap[1] && gap[1] < xRight)) {
            completedFlag = true;
            break;
          }
        }

        if (!lFlag || !rFlag) completedFlag = true;

        if (completedFlag) {
          complete(node);
        } else {
          node.r_bottom = rI;
          newNodes.push(node);
        }
      }
      nowNodes = newNodes;

      while (uI < row.length) {
        const unit = row[uI];
        // Nessuno slot oltre l'ultimo gap: unit fuori pagina (box degenere).
        // I successivi sono ordinati per x, quindi anch'essi fuori: break.
        if (gI >= rowGaps.length - 1) break;
        const xL = rowGaps[gI][1];
        const xR = rowGaps[gI + 1][0];

        if (unit[0][0] + 0.0001 > xR) {
          gI += 1;
          continue;
        }

        let found = false;
        for (const node of nowNodes) {
          if (node.x_left === xL && node.x_right === xR) {
            node.units.push(unit);
            found = true;
            break;
          }
        }

        if (found) {
          uI += 1;
          continue;
        }

        nowNodes.push({
          x_left: xL,
          x_right: xR,
          r_top: rI,
          r_bottom: rI,
          units: [unit],
          children: [],
        });

        uI += 1;
      }
    }

    for (const node of nowNodes) {
      complete(node);
    }

    for (const node of completedNodes) {
      node.children.sort((a, b) => a.x_left - b.x_left);
      node.units.sort((a, b) => a[0][1] - b[0][1]);
    }

    return root;
  }

  _preorderTraversal(root) {
    if (!root) return [];
    const stack = [root];
    const result = [];

    while (stack.length) {
      const node = stack.pop();
      result.push(node);
      stack.push(...[...node.children].reverse());
    }

    return result;
  }

  _getTextBlocks(nodes) {
    const result = [];
    for (const node of nodes) {
      for (const unit of node.units) {
        result.push(unit[1]);
      }
    }
    return result;
  }
}

/**
 * Raggruppa box detection in regioni usando GapTree per l'analisi layout.
 * GapTree raggruppa box nella stessa riga/colonna (stesso nodo) e
 * unionBoxes li fonde in un unico rettangolo per regione.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number, score?: number }[]} boxes
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {Array} Regioni con { x1, y1, x2, y2, items, sourceCount, readingOrder }
 */
export function gapTreeMergeAndOrder(boxes, pageWidth, pageHeight) {
  if (!boxes.length) return [];

  function bboxGetter(b) { return [b.x1, b.y1, b.x2, b.y2]; }

  const tree = new GapTree(bboxGetter);
  tree.sort(boxes);
  const nodeGroups = tree.getNodesTextBlocks();

  if (!nodeGroups || !nodeGroups.length) {
    return [...boxes]
      .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
      .map((b, idx) => ({ ...b, readingOrder: idx }));
  }

  let regions = nodeGroups.map((group, idx) => ({
    ...unionBoxes(group),
    items: group,
    sourceCount: group.length,
    readingOrder: idx,
  }));

  if (MERGE_VERTICAL_TOUCHING) {
    regions = mergeVerticalTouchingBlocks(regions);
  }

  return regions;
}

export default GapTree;

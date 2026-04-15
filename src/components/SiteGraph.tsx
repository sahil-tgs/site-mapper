"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

// Generic input shape — both sitemap-tree and crawl-graph produce this
export interface GraphInput {
  nodes: {
    id: string;
    label: string;
    fullUrl: string;
    isRoot: boolean;
    linkCount: number;
  }[];
  edges: {
    source: string;
    target: string;
  }[];
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  fullUrl: string;
  isRoot: boolean;
  linkCount: number;
  restX?: number;
  restY?: number;
  velX: number;
  velY: number;
  dragging: boolean;
  springBack: boolean;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: GraphNode;
  target: GraphNode;
}

interface SiteGraphProps {
  graph: GraphInput;
  graphKey?: string;
}

export function SiteGraph({ graph, graphKey }: SiteGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    nodes: GraphNode[];
    links: GraphLink[];
    transform: { x: number; y: number; k: number };
    dragNode: GraphNode | null;
    hoveredNode: GraphNode | null;
    animFrame: number;
    width: number;
    height: number;
    sim: ReturnType<typeof forceSimulation<GraphNode>> | null;
  }>({
    nodes: [],
    links: [],
    transform: { x: 0, y: 0, k: 1 },
    dragNode: null,
    hoveredNode: null,
    animFrame: 0,
    width: 0,
    height: 0,
    sim: null,
  });

  const SPRING_STIFFNESS = 0.08;
  const DAMPING = 0.82;
  const SPRING_THRESHOLD = 0.5;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { nodes, links, transform, hoveredNode } = stateRef.current;
    const w = canvas.width;
    const h = canvas.height;
    const k = transform.k;
    const totalNodes = nodes.length;
    const isLargeGraph = totalNodes > 100;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(k, k);

    // Pre-compute connected set for hovered node
    const connectedIds = new Set<string>();
    if (hoveredNode) {
      connectedIds.add(hoveredNode.id);
      for (const l of links) {
        if (l.source.id === hoveredNode.id) connectedIds.add(l.target.id);
        if (l.target.id === hoveredNode.id) connectedIds.add(l.source.id);
      }
    }

    // --- EDGES ---
    if (hoveredNode) {
      ctx.strokeStyle = "rgba(167, 139, 250, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const link of links) {
        const s = link.source;
        const t = link.target;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        if (s.id !== hoveredNode.id && t.id !== hoveredNode.id) continue;
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
      }
      ctx.stroke();
    } else if (isLargeGraph) {
      // Large graph: fade edges in with zoom, filter by connection count
      const edgeAlpha = Math.min(0.25, Math.max(0, (k - 0.2) * 0.4));
      if (edgeAlpha > 0.01) {
        const minLinks = k > 2 ? 0 : k > 1 ? 2 : k > 0.5 ? 4 : 8;
        ctx.strokeStyle = `rgba(82, 82, 91, ${edgeAlpha})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (const link of links) {
          const s = link.source;
          const t = link.target;
          if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
          if (s.linkCount < minLinks && t.linkCount < minLinks) continue;
          ctx.moveTo(s.x!, s.y!);
          ctx.lineTo(t.x!, t.y!);
        }
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "rgba(82, 82, 91, 0.3)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const link of links) {
        const s = link.source;
        const t = link.target;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
      }
      ctx.stroke();
    }

    // --- NODES ---
    const sortedNodes = hoveredNode
      ? [...nodes].sort((a, b) => {
          const aConn = connectedIds.has(a.id) ? 1 : 0;
          const bConn = connectedIds.has(b.id) ? 1 : 0;
          return aConn - bConn;
        })
      : nodes;

    // Progressive label budget: how many labels can we show at this zoom?
    // screenPx per world unit = k, so a 12px world-space label occupies 12*k screen px
    // We only show a label if it would be at least ~8 screen px tall
    const minScreenFontPx = 8;

    for (const node of sortedNodes) {
      if (node.x == null || node.y == null) continue;

      const isHovered = hoveredNode?.id === node.id;
      const isConnected = hoveredNode ? connectedIds.has(node.id) : false;
      const isDimmed = hoveredNode && !isConnected && !isHovered;

      // Fixed world-space radius — scales naturally with canvas zoom
      const importance = node.isRoot ? 4 : 1 + Math.log2(1 + node.linkCount) * 0.6;
      const radius = Math.max(4, importance * 3);

      // Glow for hovered/root
      if ((isHovered || node.isRoot) && !isDimmed) {
        const glowRadius = radius + 10;
        const gradient = ctx.createRadialGradient(
          node.x, node.y, radius * 0.5,
          node.x, node.y, glowRadius
        );
        const c = node.isRoot ? "139, 92, 246" : "167, 139, 250";
        gradient.addColorStop(0, `rgba(${c}, 0.4)`);
        gradient.addColorStop(1, `rgba(${c}, 0)`);
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);

      const alpha = isDimmed ? 0.12 : 1;
      if (node.isRoot) {
        ctx.fillStyle = `rgba(139, 92, 246, ${alpha})`;
      } else if (isHovered) {
        ctx.fillStyle = `rgba(167, 139, 250, ${alpha})`;
      } else if (isConnected) {
        ctx.fillStyle = `rgba(124, 111, 189, ${alpha})`;
      } else {
        ctx.fillStyle = `rgba(109, 109, 170, ${alpha})`;
      }
      ctx.fill();

      if (!isDimmed) {
        ctx.strokeStyle = isHovered || node.isRoot
          ? "rgba(167, 139, 250, 0.8)"
          : "rgba(113, 113, 122, 0.3)";
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.stroke();
      }

      // --- LABELS ---
      // All sizes are in WORLD SPACE — they scale naturally with zoom.
      // Only show if the resulting screen size is readable.
      const worldFontSize = isHovered || node.isRoot ? 14 : isConnected ? 12 : 10;
      const screenFontSize = worldFontSize * k;

      const shouldShowLabel =
        isHovered ||
        (node.isRoot && !isDimmed) ||
        (isConnected && !isDimmed && screenFontSize >= minScreenFontPx) ||
        (!isDimmed && screenFontSize >= minScreenFontPx &&
          (!isLargeGraph || node.linkCount >= 2));

      if (shouldShowLabel) {
        ctx.font = `${isHovered || node.isRoot ? "600" : "400"} ${worldFontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        // Show more chars as zoom increases (more screen space available)
        const maxChars = Math.floor(12 + k * 30);
        const text = node.label.length > maxChars
          ? node.label.slice(0, maxChars - 2) + "..."
          : node.label;

        const labelOffset = radius + 5;

        // Text shadow
        ctx.fillStyle = "rgba(9, 9, 11, 0.9)";
        ctx.fillText(text, node.x + 0.5, node.y + labelOffset + 0.5);

        const labelAlpha = isDimmed ? 0.1 : isHovered || isConnected ? 1 : 0.7;
        ctx.fillStyle = isHovered || node.isRoot
          ? `rgba(228, 228, 231, ${labelAlpha})`
          : isConnected
            ? `rgba(181, 181, 190, ${labelAlpha})`
            : `rgba(140, 140, 150, ${labelAlpha})`;
        ctx.fillText(text, node.x, node.y + labelOffset);
      }
    }

    // Tooltip (drawn in screen space so it's always readable)
    if (hoveredNode && hoveredNode.x != null && hoveredNode.y != null) {
      ctx.restore(); // exit world space
      ctx.save();

      // Convert hovered node world pos to screen pos
      const sx = hoveredNode.x * k + transform.x;
      const sy = hoveredNode.y * k + transform.y;

      const tooltipText = hoveredNode.fullUrl;
      const tipFontSize = 12;
      ctx.font = `400 ${tipFontSize}px Inter, system-ui, monospace`;
      const metrics = ctx.measureText(tooltipText);
      const padding = 8;
      const boxW = metrics.width + padding * 2;
      const boxH = tipFontSize + padding * 2;
      const ty = sy - 30;

      ctx.fillStyle = "rgba(24, 24, 27, 0.95)";
      ctx.beginPath();
      ctx.roundRect(sx - boxW / 2, ty - boxH / 2, boxW, boxH, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(63, 63, 70, 0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#e4e4e7";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tooltipText, sx, ty);

      ctx.restore();
      return; // already restored
    }

    ctx.restore();
  }, []);

  const animate = useCallback(() => {
    const { nodes } = stateRef.current;
    let needsRedraw = false;

    for (const node of nodes) {
      if (!node.springBack || node.dragging) continue;
      if (node.restX == null || node.restY == null || node.x == null || node.y == null) continue;

      const dx = node.restX - node.x;
      const dy = node.restY - node.y;

      node.velX = (node.velX + dx * SPRING_STIFFNESS) * DAMPING;
      node.velY = (node.velY + dy * SPRING_STIFFNESS) * DAMPING;

      node.x += node.velX;
      node.y += node.velY;

      if (Math.abs(dx) < SPRING_THRESHOLD && Math.abs(dy) < SPRING_THRESHOLD &&
          Math.abs(node.velX) < SPRING_THRESHOLD && Math.abs(node.velY) < SPRING_THRESHOLD) {
        node.x = node.restX;
        node.y = node.restY;
        node.velX = 0;
        node.velY = 0;
        node.springBack = false;
      } else {
        needsRedraw = true;
      }
    }

    draw();

    if (needsRedraw) {
      stateRef.current.animFrame = requestAnimationFrame(animate);
    }
  }, [draw]);

  const startAnimation = useCallback(() => {
    cancelAnimationFrame(stateRef.current.animFrame);
    stateRef.current.animFrame = requestAnimationFrame(animate);
  }, [animate]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    stateRef.current.sim?.stop();

    const resize = () => {
      const parent = canvas.parentElement!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width = parent.clientWidth + "px";
      canvas.style.height = parent.clientHeight + "px";
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(dpr, dpr);
      stateRef.current.width = parent.clientWidth;
      stateRef.current.height = parent.clientHeight;
      draw();
    };

    const nodes: GraphNode[] = graph.nodes.map((n) => ({
      ...n,
      velX: 0,
      velY: 0,
      dragging: false,
      springBack: false,
    }));

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const links: GraphLink[] = graph.edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
      }));

    stateRef.current.nodes = nodes;
    stateRef.current.links = links;

    const parent = canvas.parentElement!;
    stateRef.current.transform = {
      x: parent.clientWidth / 2,
      y: parent.clientHeight / 2,
      k: 1,
    };

    resize();

    // Force params — VERY strong repulsion + large link distance for real spacing
    const n = nodes.length;
    const chargeStrength = n > 500 ? -600 : n > 200 ? -800 : n > 50 ? -1000 : -1200;
    const chargeMax = n > 500 ? 2000 : n > 200 ? 1500 : 1000;
    const linkDist = n > 500 ? 200 : n > 200 ? 250 : n > 50 ? 300 : 350;
    const linkStr = n > 500 ? 0.1 : n > 200 ? 0.15 : 0.2;
    const collideRadius = n > 500 ? 30 : n > 200 ? 40 : 50;

    // Auto zoom-to-fit for large graphs
    if (n > 100) {
      stateRef.current.transform.k = Math.max(0.08, 0.6 - n / 2000);
    } else if (n > 30) {
      stateRef.current.transform.k = 0.7;
    }

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(linkDist)
          .strength(linkStr)
      )
      .force("charge", forceManyBody().strength(chargeStrength).distanceMax(chargeMax))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(collideRadius))
      .alphaDecay(0.012)
      .on("tick", () => draw())
      .on("end", () => {
        for (const node of nodes) {
          node.restX = node.x;
          node.restY = node.y;
        }
      });

    stateRef.current.sim = sim;

    const settleTimer = setTimeout(() => {
      for (const node of nodes) {
        if (node.restX == null) {
          node.restX = node.x;
          node.restY = node.y;
        }
      }
    }, 5000);

    // Mouse interactions — simple k scaling, no spread hack
    function screenToWorld(sx: number, sy: number) {
      const t = stateRef.current.transform;
      return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
    }

    function findNode(wx: number, wy: number): GraphNode | null {
      const { nodes: ns } = stateRef.current;
      const kk = stateRef.current.transform.k;
      for (let i = ns.length - 1; i >= 0; i--) {
        const nd = ns[i];
        if (nd.x == null || nd.y == null) continue;
        // Hit area: at least 10px on screen, or the node's world radius
        const importance = nd.isRoot ? 4 : 1 + Math.log2(1 + nd.linkCount) * 0.6;
        const worldR = Math.max(4, importance * 3);
        const hitR = Math.max(worldR, 10 / kk); // 10 screen-px minimum
        const dx = nd.x - wx;
        const dy = nd.y - wy;
        if (dx * dx + dy * dy < hitR * hitR) return nd;
      }
      return null;
    }

    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let didDrag = false;

    function onMouseDown(e: MouseEvent) {
      didDrag = false;
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const node = findNode(wx, wy);

      if (node) {
        stateRef.current.dragNode = node;
        node.dragging = true;
        node.springBack = false;
        node.velX = 0;
        node.velY = 0;
        if (node.restX == null) {
          node.restX = node.x;
          node.restY = node.y;
        }
        dragOffsetX = node.x! - wx;
        dragOffsetY = node.y! - wy;
        canvas!.style.cursor = "grabbing";
      } else {
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
        canvas!.style.cursor = "grabbing";
      }
    }

    function onMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = screenToWorld(sx, sy);

      if (stateRef.current.dragNode) {
        didDrag = true;
        const node = stateRef.current.dragNode;
        node.x = wx + dragOffsetX;
        node.y = wy + dragOffsetY;
        node.fx = node.x;
        node.fy = node.y;
        draw();
        return;
      }

      if (isPanning) {
        didDrag = true;
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        stateRef.current.transform.x += dx;
        stateRef.current.transform.y += dy;
        panStart = { x: e.clientX, y: e.clientY };
        draw();
        return;
      }

      const node = findNode(wx, wy);
      if (node !== stateRef.current.hoveredNode) {
        stateRef.current.hoveredNode = node;
        canvas!.style.cursor = node ? "pointer" : "default";
        draw();
      }
    }

    function onMouseUp() {
      if (stateRef.current.dragNode) {
        const node = stateRef.current.dragNode;
        node.dragging = false;
        node.fx = null;
        node.fy = null;
        node.springBack = true;
        node.velX = 0;
        node.velY = 0;
        stateRef.current.dragNode = null;
        startAnimation();
      }
      isPanning = false;
      canvas!.style.cursor = stateRef.current.hoveredNode ? "pointer" : "default";
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const t = stateRef.current.transform;

      const zoom = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newK = Math.max(0.02, Math.min(8, t.k * zoom));

      // Zoom toward cursor
      t.x = sx - (sx - t.x) * (newK / t.k);
      t.y = sy - (sy - t.y) * (newK / t.k);
      t.k = newK;
      draw();
    }

    function onClick(e: MouseEvent) {
      if (didDrag) return;
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const node = findNode(wx, wy);
      if (node) {
        window.open(node.fullUrl, "_blank", "noopener");
      }
    }

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("click", onClick);
    window.addEventListener("resize", resize);

    return () => {
      sim.stop();
      clearTimeout(settleTimer);
      cancelAnimationFrame(stateRef.current.animFrame);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("resize", resize);
    };
  }, [graph, graphKey, draw, startAnimation]);

  return (
    <div className="w-full h-full relative bg-zinc-950">
      <canvas ref={canvasRef} className="block w-full h-full" />
      <div className="absolute bottom-4 left-4 text-zinc-600 text-xs space-y-0.5">
        <div>Scroll to zoom &middot; Drag to pan &middot; Drag nodes to pull</div>
        <div>Click a node to open URL in new tab</div>
      </div>
    </div>
  );
}

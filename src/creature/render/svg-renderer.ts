/**
 * SVG renderer.
 *
 * Draws a pose. It makes no decisions: no state machine, no foot placement, no
 * speed, no colour derivation beyond what the appearance already carries. Given
 * the same pose it produces the same frame, which keeps animation logic out of
 * the drawing code entirely.
 *
 * Styles are set as attributes rather than CSS classes so the picture does not
 * depend on page CSS. Colours come from `CreatureAppearance.style`, so an
 * evolution that changes the palette needs no renderer change.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';
import type { CreatureAppearance } from '@/shared/types/creature';
import type { CreaturePose, LimbPose } from '../rig/pose';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface RenderOptions {
  /** Pixels subtracted from document-space coordinates (the scroll offset). */
  readonly scrollX: number;
  readonly scrollY: number;
  /** Layout viewport size in CSS px; the SVG is sized to it. */
  readonly width: number;
  readonly height: number;
}

interface LimbNodes {
  readonly shadow: SVGPathElement;
  readonly path: SVGPathElement;
  readonly foot: SVGCircleElement;
  readonly joint: SVGCircleElement;
}

const BODY_GRADIENT_ID = 'xrawl-creature-body';
const GLOW_FILTER_ID = 'xrawl-creature-glow';

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export class CreatureRenderer {
  private readonly doc: Document;
  private readonly svg: SVGSVGElement;
  private readonly shadowLayer: SVGElement;
  private readonly limbLayer: SVGElement;
  private readonly bodyLayer: SVGElement;
  private readonly bodyGroup: SVGElement;
  private readonly jawPath: SVGPathElement;

  private readonly gradientStart: SVGElement;
  private readonly gradientEnd: SVGElement;

  private limbNodes: LimbNodes[] = [];
  private bodySegments: SVGEllipseElement[] = [];
  private appearance: CreatureAppearance;

  constructor(doc: Document, appearance: CreatureAppearance) {
    this.doc = doc;
    this.appearance = appearance;

    this.svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute(XRAWL_CONFIG.overlayAttribute, 'creature');
    this.svg.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      `z-index:${XRAWL_CONFIG.creature.zIndex}`,
      'overflow:visible',
    ].join(';');

    const defs = doc.createElementNS(SVG_NS, 'defs');

    const gradient = doc.createElementNS(SVG_NS, 'linearGradient');
    gradient.setAttribute('id', BODY_GRADIENT_ID);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0');
    gradient.setAttribute('y2', '1');
    this.gradientStart = doc.createElementNS(SVG_NS, 'stop');
    this.gradientStart.setAttribute('offset', '0');
    this.gradientEnd = doc.createElementNS(SVG_NS, 'stop');
    this.gradientEnd.setAttribute('offset', '1');
    gradient.append(this.gradientStart, this.gradientEnd);
    defs.appendChild(gradient);

    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', GLOW_FILTER_ID);
    filter.setAttribute('x', '-40%');
    filter.setAttribute('y', '-40%');
    filter.setAttribute('width', '180%');
    filter.setAttribute('height', '180%');
    const blur = doc.createElementNS(SVG_NS, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '2.4');
    filter.appendChild(blur);
    defs.appendChild(filter);

    this.svg.appendChild(defs);

    this.shadowLayer = this.createGroup('shadow');
    this.limbLayer = this.createGroup('limbs');
    this.bodyLayer = this.createGroup('body');
    this.svg.append(this.shadowLayer, this.limbLayer, this.bodyLayer);

    this.bodyGroup = this.createGroup('segments');
    this.bodyLayer.appendChild(this.bodyGroup);

    this.jawPath = doc.createElementNS(SVG_NS, 'path') as SVGPathElement;
    this.jawPath.setAttribute('data-role', 'jaw');
    this.jawPath.setAttribute('fill', appearance.style.accentColor);
    this.bodyLayer.appendChild(this.jawPath);

    this.applyAppearance(appearance);
  }

  /** The mounted element; the host appends it to the document once. */
  get element(): SVGSVGElement {
    return this.svg;
  }

  /** Rebuild structure + style when evolution changes the palette or limb count. */
  applyAppearance(appearance: CreatureAppearance): void {
    this.appearance = appearance;
    const { style, limbs } = appearance;

    this.svg.setAttribute('opacity', String(style.opacity));

    this.gradientStart.setAttribute('stop-color', style.primaryColor);
    this.gradientEnd.setAttribute('stop-color', style.secondaryColor);

    if (this.limbNodes.length !== limbs.count) this.rebuildLimbs(limbs.count);

    for (const nodes of this.limbNodes) {
      nodes.shadow.setAttribute('stroke', style.secondaryColor);
      nodes.shadow.setAttribute('stroke-width', String(limbs.strokeWidth * 1.5));
      nodes.path.setAttribute('stroke', style.primaryColor);
      nodes.path.setAttribute('stroke-width', String(limbs.strokeWidth));
      nodes.joint.setAttribute('r', String(limbs.jointSize));
      nodes.joint.setAttribute('fill', style.accentColor);
      nodes.foot.setAttribute('fill', style.secondaryColor);
    }

    this.rebuildBody();
  }

  /**
   * Draw one pose. Document-space coordinates are translated by `-scroll`, so
   * the fixed-position SVG always matches the visible viewport.
   */
  render(pose: CreaturePose, options: RenderOptions): void {
    this.svg.setAttribute('data-action', pose.action);
    const width = `${options.width}px`;
    const height = `${options.height}px`;
    if (this.svg.style.width !== width) this.svg.style.width = width;
    if (this.svg.style.height !== height) this.svg.style.height = height;
    this.svg.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);

    this.svg.setAttribute(
      'transform',
      `translate(${round(-options.scrollX)} ${round(-options.scrollY)})`,
    );
    // Exposes the current state without any test-only hook in the engine.


    for (const limb of pose.limbs) this.renderLimb(limb);
    this.renderBody(pose);
  }

  private renderLimb(limb: LimbPose): void {
    const nodes = this.limbNodes[limb.index];
    if (!nodes) return;

    nodes.path.setAttribute('d', pathFor(limb));
    nodes.path.setAttribute('opacity', limb.stepping ? '0.68' : '1');
    nodes.shadow.setAttribute('d', pathFor(limb, limb.lift));

    const foot = limb.joints[limb.joints.length - 1]!;
    nodes.joint.setAttribute('cx', String(round(foot.x)));
    nodes.joint.setAttribute('cy', String(round(foot.y)));
    nodes.joint.setAttribute(
      'r',
      String(this.appearance.limbs.jointSize * (limb.stepping ? 0.76 : 1)),
    );

    // The ground marker stays put while the foot lifts; that is what reads as
    // "off the ground" rather than the whole limb sliding.
    nodes.foot.setAttribute('cx', String(round(foot.x)));
    nodes.foot.setAttribute('cy', String(round(foot.y + limb.lift)));
    nodes.foot.setAttribute('r', String(Math.max(0.9, this.appearance.limbs.jointSize * 0.85)));
    nodes.foot.setAttribute('opacity', limb.stepping ? '0.5' : '0');
    // `data-lift` makes "is this foot in the air?" inspectable without pixels.
    nodes.foot.setAttribute('data-lift', limb.stepping ? 'airborne' : 'planted');
    nodes.foot.setAttribute('data-lift-px', String(round(limb.lift)));
  }

  private renderBody(pose: CreaturePose): void {
    const { body, bob, heading } = pose;
    const segments = this.bodySegments.length;
    if (segments === 0) return;

    this.bodyGroup.setAttribute(
      'transform',
      `translate(${round(body.cx)} ${round(body.cy - bob)}) rotate(${round(degrees(heading))})`,
    );

    for (let index = 0; index < segments; index += 1) {
      const node = this.bodySegments[index]!;
      const t = segments === 1 ? 0 : index / (segments - 1);
      // The tail tapers; the abdomen (last segment) bulges when fed.
      const taper = 1 - t * 0.42;
      const bulge = index === segments - 1 ? 1 + pose.satiety * 0.22 : 1;
      node.setAttribute('cx', String(round(-body.rx * t * 0.9)));
      node.setAttribute('cy', '0');
      node.setAttribute('rx', String(round(body.rx * taper * bulge)));
      node.setAttribute('ry', String(round(body.ry * taper * bulge)));
    }

    // Glow tracks the palette's accent colour and strength, so an evolved
    // creature glows differently without any renderer branch.
    this.bodyGroup.setAttribute('filter', this.appearance.style.glow > 0.25 ? `url(#${GLOW_FILTER_ID})` : 'none');

    // The jaw hangs off the head (forward tip of the body).
    this.jawPath.setAttribute(
      'transform',
      `translate(${round(pose.head.x)} ${round(pose.head.y - bob)}) rotate(${round(degrees(heading))})`,
    );
    this.jawPath.setAttribute('d', jawPath(pose.jaw, body.ry));
    this.jawPath.setAttribute('fill', this.appearance.style.accentColor);
  }

  private rebuildLimbs(count: number): void {
    for (const nodes of this.limbNodes) {
      nodes.shadow.remove();
      nodes.path.remove();
      nodes.joint.remove();
      nodes.foot.remove();
    }

    this.limbNodes = [];
    for (let index = 0; index < count; index += 1) {
      const shadow = this.createElement('path') as SVGPathElement;
      shadow.setAttribute('data-limb', String(index));
      shadow.setAttribute('data-role', 'shadow');
      shadow.setAttribute('fill', 'none');
      shadow.setAttribute('stroke-linecap', 'round');
      shadow.setAttribute('stroke-linejoin', 'round');
      shadow.setAttribute('opacity', '0.28');
      this.shadowLayer.appendChild(shadow);

      const path = this.createElement('path') as SVGPathElement;
      path.setAttribute('data-limb', String(index));
      path.setAttribute('data-role', 'limb');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      this.limbLayer.appendChild(path);

      const foot = this.createElement('circle') as SVGCircleElement;
      foot.setAttribute('fill', 'none');
      foot.setAttribute('data-limb', String(index));
      foot.setAttribute('data-role', 'foot');
      this.limbLayer.appendChild(foot);

      const joint = this.createElement('circle') as SVGCircleElement;
      this.limbLayer.appendChild(joint);

      this.limbNodes.push({ shadow, path, joint, foot });
    }
  }

  private rebuildBody(): void {
    for (const segment of this.bodySegments) segment.remove();
    this.bodySegments = [];

    const count = Math.max(1, this.appearance.body.segments);
    for (let index = 0; index < count; index += 1) {
      const ellipse = this.createElement('ellipse') as SVGEllipseElement;
      ellipse.setAttribute(
        'fill',
        index === 0 ? `url(#${BODY_GRADIENT_ID})` : this.appearance.style.secondaryColor,
      );
      ellipse.setAttribute('stroke', this.appearance.style.primaryColor);
      ellipse.setAttribute('stroke-width', '0.8');
      // Tail first so the head paints on top.
      this.bodyGroup.insertBefore(ellipse, this.bodyGroup.firstChild);
      this.bodySegments.unshift(ellipse);
    }
  }

  private createGroup(name: string): SVGElement {
    const group = this.createElement('g');
    group.setAttribute('data-part', name);
    return group;
  }

  private createElement(tag: string): SVGElement {
    return this.doc.createElementNS(SVG_NS, tag) as unknown as SVGElement;
  }
}

/** Path through a limb's joints, shifted down by `lift` to draw a ground shadow. */
function pathFor(limb: LimbPose, lift = 0): string {
  const joints = limb.joints;
  if (joints.length < 2) return '';
  const points: string[] = [];
  for (let index = 0; index < joints.length; index += 1) {
    const joint = joints[index]!;
    points.push(`${round(joint.x)} ${round(joint.y + (index === joints.length - 1 ? lift : 0))}`);
  }
  return `M ${points.join(' L ')}`;
}

/** Two symmetric mandibles that open with `jaw` (0 closed, 1 wide). */
function jawPath(jaw: number, bodyRadius: number): string {
  const spread = 0.18 + jaw * 0.55;
  const length = Math.max(2, bodyRadius * 0.5);
  const upperY = -spread * length;
  const lowerY = spread * length;
  return [
    `M 0 0 Q ${round(length * 0.7)} ${round(upperY)} ${round(length)} ${round(upperY * 0.8)}`,
    `M 0 0 Q ${round(length * 0.7)} ${round(lowerY)} ${round(length)} ${round(lowerY * 0.8)}`,
  ].join(' ');
}

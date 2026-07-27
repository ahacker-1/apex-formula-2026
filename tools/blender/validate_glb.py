# Re-imports assets/f1car-2026.glb and asserts the export contract.
#
#   Blender --background --python tools/blender/validate_glb.py -- [--dump]
#
# Exit code 1 on any failure.  --dump also prints every object's authoring-frame
# bounding box, which is how modelling regressions get located.

import bpy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from f1_lib import world_bbox

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
GLB = os.path.join(ROOT, 'assets', 'f1car-2026.glb')
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

EPS = 0.01
WHEEL_POS = {
    'wheel_fl': (-0.82, 0.34, 1.55),
    'wheel_fr': (0.82, 0.34, 1.55),
    'wheel_rl': (-0.85, 0.34, -1.60),
    'wheel_rr': (0.85, 0.34, -1.60),
}
WHEEL_WIDTH = {'wheel_fl': 0.30, 'wheel_fr': 0.30,
               'wheel_rl': 0.38, 'wheel_rr': 0.38}
REQUIRED_MATS = ['body', 'accent', 'carbon', 'tyre', 'rim', 'glow',
                 'rainlight', 'band']
TRI_MIN, TRI_MAX = 25000, 60000
# X: the rear track (+-0.85 centres, 0.38 wide) is 2.088 by construction, so the
# 2.0 limit in the brief is checked against the BODYWORK and the wheels get the
# arithmetic minimum the wheel contract implies.
BODY_BOX = (5.4, 2.0, 1.1)
FULL_BOX = (5.4, 2.09, 1.1)

fails = []
oks = []


def check(cond, msg, detail=''):
    (oks if cond else fails).append(
        ('%s %s' % (msg, detail)).rstrip())


def authoring(mw, co):
    w = mw @ co
    return (w.x, w.z, -w.y)


def obj_bbox(o):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for v in o.data.vertices:
        a = authoring(o.matrix_world, v.co)
        for i in range(3):
            lo[i] = min(lo[i], a[i])
            hi[i] = max(hi[i], a[i])
    return lo, hi


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    bpy.context.view_layer.update()

    objs = {o.name: o for o in bpy.data.objects}
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']

    # ---- named nodes -------------------------------------------------------
    for name in list(WHEEL_POS) + ['body_root', 'brake_glow_l', 'brake_glow_r',
                                   'rain_light']:
        check(name in objs, "node '%s' present" % name)

    for name, want in WHEEL_POS.items():
        o = objs.get(name)
        if not o:
            continue
        got = authoring(o.matrix_world.copy(), o.matrix_world.inverted()
                        @ o.matrix_world.translation)
        got = (o.matrix_world.translation.x, o.matrix_world.translation.z,
               -o.matrix_world.translation.y)
        d = max(abs(got[i] - want[i]) for i in range(3))
        check(d <= EPS, "'%s' at (%.2f, %.2f, %.2f)" % ((name,) + want),
              '[got (%.4f, %.4f, %.4f) delta=%.4f]' % (got + (d,)))

    # ---- wheel contents ---------------------------------------------------
    for name in WHEEL_POS:
        o = objs.get(name)
        if not o:
            continue
        kids = {c.name.split('_')[0]: c for c in o.children if c.type == 'MESH'}
        key = name.split('_')[1]
        check(set(kids) == {'tyre', 'rim', 'band'},
              "'%s' holds tyre+rim+band" % name, '[%s]' % ','.join(sorted(kids)))
        t = kids.get('tyre')
        if t:
            lo, hi = obj_bbox(t)
            # radius: tread crown measured from the node origin
            cy, cz = WHEEL_POS[name][1], WHEEL_POS[name][2]
            r = max(hi[1] - cy, cy - lo[1], hi[2] - cz, cz - lo[2])
            check(abs(r - 0.34) <= 0.002, "tyre_%s radius 0.34" % key,
                  '[%.4f]' % r)
            w = hi[0] - lo[0]
            check(abs(w - WHEEL_WIDTH[name]) <= 0.005,
                  "tyre_%s width %.2f" % (key, WHEEL_WIDTH[name]), '[%.4f]' % w)
        b = kids.get('band')
        if b:
            check(b.data.materials and b.data.materials[0].name == 'band',
                  "band_%s uses material 'band'" % key)

    # wheels symmetric about x = 0
    for a, b in (('wheel_fl', 'wheel_fr'), ('wheel_rl', 'wheel_rr')):
        pa, pb = objs.get(a), objs.get(b)
        if not (pa and pb):
            continue
        ta, tb = pa.matrix_world.translation, pb.matrix_world.translation
        check(abs(ta.x + tb.x) <= 1e-6 and abs(ta.y - tb.y) <= 1e-6
              and abs(ta.z - tb.z) <= 1e-6, '%s / %s are mirror images' % (a, b),
              '[%.4f vs %.4f]' % (ta.x, tb.x))

    # ---- body_root holds every non-wheel mesh ------------------------------
    root = objs.get('body_root')
    if root:
        wheel_meshes = set()
        for name in WHEEL_POS:
            if name in objs:
                wheel_meshes |= {c.name for c in objs[name].children}
        orphans = [o.name for o in meshes
                   if o.name not in wheel_meshes
                   and (o.parent is None or o.parent.name != 'body_root')]
        check(not orphans, "'body_root' parents every non-wheel mesh",
              '[orphans: %s]' % ','.join(orphans) if orphans else '')

    # ---- materials --------------------------------------------------------
    mats = {m.name for m in bpy.data.materials}
    for m in REQUIRED_MATS:
        check(m in mats, "material '%s' exported" % m)
    check(all(o.data.materials and o.data.materials[0] for o in meshes),
          'every mesh has a material')
    for name, want in (('brake_glow_l', 'glow'), ('brake_glow_r', 'glow'),
                       ('rain_light', 'rainlight')):
        o = objs.get(name)
        if o:
            check(o.data.materials and o.data.materials[0].name == want,
                  "'%s' uses material '%s'" % (name, want),
                  '[%s]' % (o.data.materials[0].name if o.data.materials else '-'))

    # ---- triangles --------------------------------------------------------
    tris = 0
    for o in meshes:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    check(TRI_MIN <= tris <= TRI_MAX,
          'triangle count in [%d, %d]' % (TRI_MIN, TRI_MAX), '[%d]' % tris)

    # ---- bounding boxes ---------------------------------------------------
    lo, hi = world_bbox(meshes)
    size = [hi[i] - lo[i] for i in range(3)]
    check(size[2] <= FULL_BOX[0] and size[0] <= FULL_BOX[1]
          and size[1] <= FULL_BOX[2],
          'full bbox within %.2f x %.2f x %.2f (L x W x H)' % FULL_BOX,
          '[%.3f x %.3f x %.3f]' % (size[2], size[0], size[1]))
    check(lo[1] >= -1e-6, 'no geometry below y = 0', '[min y = %.6f]' % lo[1])
    check(4.6 <= size[2] <= 5.4, 'length is ~5.0 m', '[%.3f]' % size[2])

    body = [o for o in meshes if o.parent and o.parent.name == 'body_root']
    blo, bhi = world_bbox(body)
    bsize = [bhi[i] - blo[i] for i in range(3)]
    check(bsize[2] <= BODY_BOX[0] and bsize[0] <= BODY_BOX[1]
          and bsize[1] <= BODY_BOX[2],
          'bodywork bbox within %.2f x %.2f x %.2f' % BODY_BOX,
          '[%.3f x %.3f x %.3f]' % (bsize[2], bsize[0], bsize[1]))
    check(bhi[0] <= 0.96 and blo[0] >= -0.96,
          'bodywork is ~1.90 m wide', '[%.3f .. %.3f]' % (blo[0], bhi[0]))

    # floor bottom sits at 0.03
    fl = objs.get('floor')
    if fl:
        flo, _fhi = obj_bbox(fl)
        check(abs(flo[1] - 0.03) <= 0.002, 'floor bottom at y = 0.03',
              '[%.4f]' % flo[1])

    # ---- mesh hygiene: no loose verts/edges, no degenerate faces ----------
    loose_v = loose_e = degen = 0
    for o in meshes:
        me = o.data
        used = set()
        for p in me.polygons:
            used.update(p.vertices)
            if p.area < 1e-9:
                degen += 1
        loose_v += len(me.vertices) - len(used)
        in_face = set()
        for p in me.polygons:
            vs = list(p.vertices)
            for i in range(len(vs)):
                in_face.add(frozenset((vs[i], vs[(i + 1) % len(vs)])))
        for e in me.edges:
            if frozenset(e.vertices) not in in_face:
                loose_e += 1
    check(loose_v == 0, 'no loose vertices', '[%d]' % loose_v)
    check(loose_e == 0, 'no loose edges', '[%d]' % loose_e)
    check(degen == 0, 'no degenerate faces', '[%d]' % degen)

    # ---- normals point outward -------------------------------------------
    # For a closed shell, the signed volume from the face normals must be > 0.
    bad = []
    for o in meshes:
        me = o.data
        vol = 0.0
        for p in me.polygons:
            vs = [me.vertices[i].co for i in p.vertices]
            for i in range(1, len(vs) - 1):
                a, b, c = vs[0], vs[i], vs[i + 1]
                vol += a.dot(b.cross(c))
        if vol <= 0:
            bad.append('%s(%.4f)' % (o.name, vol / 6.0))
    check(not bad, 'every shell has outward normals (positive volume)',
          '[%s]' % ','.join(bad) if bad else '')

    if '--dump' in ARGV:
        print('\n--- object bounding boxes (authoring frame) ---')
        for o in sorted(meshes, key=lambda o: o.name):
            l, h = obj_bbox(o)
            o.data.calc_loop_triangles()
            print('  %-26s x[%+.3f %+.3f] y[%+.3f %+.3f] z[%+.3f %+.3f] %5d tris'
                  % (o.name, l[0], h[0], l[1], h[1], l[2], h[2],
                     len(o.data.loop_triangles)))

    print('\n=== GLB contract validation ===')
    for m in oks:
        print('  ok    %s' % m)
    for m in fails:
        print('  FAIL  %s' % m)
    print('%d passed, %d failed' % (len(oks), len(fails)))
    if fails:
        sys.exit(1)


if __name__ == '__main__':
    main()

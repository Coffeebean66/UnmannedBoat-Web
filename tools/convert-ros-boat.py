"""将 ROS URDF/STL 装配离线转换为 WebGL 1 可用的纯色 GLB。用法见 MODEL_SETUP.md。"""
import argparse
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET

import numpy as np


WEB = Path(__file__).resolve().parents[1]


def vector(element, name, default):
    return [float(v) for v in element.get(name, default).split()]


def origin(element):
    """URDF 的固定轴 RPY 顺序是 Rz(yaw) @ Ry(pitch) @ Rx(roll)。"""
    if element is None:
        return np.eye(4)
    roll, pitch, yaw = vector(element, 'rpy', '0 0 0')
    cr, sr, cp, sp, cy, sy = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
    result = np.eye(4)
    result[:3, :3] = [
        [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
        [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
        [-sp, cp * sr, cp * cr],
    ]
    result[:3, 3] = vector(element, 'xyz', '0 0 0')
    return result


def read_stl(file):
    data = file.read_bytes()
    count = struct.unpack_from('<I', data, 80)[0]
    if len(data) != 84 + count * 50:
        raise ValueError(f'需要二进制 STL：{file}')
    dtype = np.dtype([('normal', '<f4', 3), ('points', '<f4', (3, 3)), ('attribute', '<u2')])
    triangles = np.frombuffer(data, dtype=dtype, count=count, offset=84)['points']
    points = triangles.reshape(-1, 3)
    if not np.isfinite(points).all():
        raise ValueError(f'STL 含无效坐标：{file}')
    # 焊接误差不超过 0.001 mm，避免 CAD 相邻面微小浮点差造成无法减面。
    _, first, inverse = np.unique(points.round(3), axis=0, return_index=True, return_inverse=True)
    positions = points[first].copy()
    indices = inverse.reshape(-1, 3).astype('<u4')
    valid = (indices[:, 0] != indices[:, 1]) & (indices[:, 1] != indices[:, 2]) & (indices[:, 0] != indices[:, 2])
    return positions, indices[valid], count


def preserve_hard_edges(positions, faces):
    """平滑相邻曲面；在大于 50° 的边缘拆顶点，保留支架、电池等硬边。"""
    triangles = positions[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    faces, normals = faces[lengths > 1e-10], normals[lengths > 1e-10] / lengths[lengths > 1e-10, None]
    parent = np.arange(faces.size)

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    edges = {}
    threshold = math.cos(math.radians(50))
    for face_index, face in enumerate(faces):
        for a, b in ((0, 1), (1, 2), (2, 0)):
            va, vb = int(face[a]), int(face[b])
            ca, cb = face_index * 3 + a, face_index * 3 + b
            if va > vb:
                va, vb, ca, cb = vb, va, cb, ca
            key = (va, vb)
            previous = edges.get(key)
            if previous is None:
                edges[key] = (face_index, ca, cb)
            elif float(normals[face_index] @ normals[previous[0]]) >= threshold:
                parent[root(ca)] = root(previous[1])
                parent[root(cb)] = root(previous[2])
    roots = np.fromiter((root(i) for i in range(faces.size)), dtype=np.int64)
    _, first, inverse = np.unique(roots, return_index=True, return_inverse=True)
    return positions[faces.reshape(-1)[first]], inverse.reshape(-1, 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--urdf', type=Path, default=WEB.parent / 'boat_ros1_jnu_motors_v6/boat_description/urdf/boat.urdf')
    parser.add_argument('--meshoptimizer', type=Path, default=WEB / '.test-output/model-tools/node_modules/meshoptimizer/index.js')
    parser.add_argument('--output', type=Path, default=WEB / 'public/assets/boat_jnu_motors_v6.glb')
    args = parser.parse_args()
    if not args.meshoptimizer.is_file():
        parser.error('缺少离线减面工具，安装步骤见 MODEL_SETUP.md')
    robot = ET.parse(args.urdf).getroot()
    package = args.urdf.resolve().parent.parent
    document = {
        'asset': {'version': '2.0', 'generator': 'UnmannedBoat URDF/STL converter', 'extras': {
            'source': 'boat_ros1_jnu_motors_v6/boat_description/urdf/boat.urdf',
            'bodyAxes': 'X forward, Y port, Z up', 'waterlineY': 0.05,
            'waterlineNote': 'Display effect only; not a measured draft',
        }},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        # 与姿态换基一致：ROS (X,Y,Z) -> glTF (X,Z,-Y)，仅在根节点转换一次。
        'nodes': [{'name': robot.get('name'), 'matrix': [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], 'children': []}],
        'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [],
    }
    binary = bytearray()

    def accessor(array, component, kind, target):
        while len(binary) % 4:
            binary.append(0)
        view = len(document['bufferViews'])
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': array.nbytes, 'target': target})
        binary.extend(array.tobytes())
        result = {'bufferView': view, 'componentType': component, 'count': len(array), 'type': kind}
        if kind == 'VEC3':
            result.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        document['accessors'].append(result)
        return len(document['accessors']) - 1

    materials = {}
    for material in robot.findall('material'):
        rgba = vector(material.find('color'), 'rgba', '1 1 1 1')
        linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgba[:3]] + rgba[3:]
        materials[material.get('name')] = len(document['materials'])
        document['materials'].append({'name': material.get('name'), 'doubleSided': True, 'pbrMetallicRoughness': {
            'baseColorFactor': linear, 'metallicFactor': 0.12, 'roughnessFactor': 0.72,
        }})

    links = {}
    for link in robot.findall('link'):
        links[link.get('name')] = len(document['nodes'])
        document['nodes'].append({'name': link.get('name'), 'children': []})
    children = set()
    for joint in robot.findall('joint'):
        if joint.get('type') != 'fixed':
            raise ValueError('当前离线船模只支持固定装配')
        parent, child = joint.find('parent').get('link'), joint.find('child').get('link')
        document['nodes'][links[parent]]['children'].append(links[child])
        document['nodes'][links[child]]['matrix'] = origin(joint.find('origin')).flatten(order='F').tolist()
        children.add(child)
    document['nodes'][0]['children'] = [index for name, index in links.items() if name not in children]

    cache, report = {}, []
    visual_count = 0
    with tempfile.TemporaryDirectory(prefix='boat-mesh-') as temp:
        directory = Path(temp)
        for link in robot.findall('link'):
            for visual in link.findall('visual'):
                mesh = visual.find('geometry/mesh')
                if mesh is None:
                    raise ValueError('本转换器需要 mesh visual，不能静默丢弃部件')
                filename = mesh.get('filename')
                prefix = f'package://{package.name}/'
                if not filename.startswith(prefix):
                    raise ValueError(f'不支持的包路径：{filename}')
                source = (package / filename[len(prefix):]).with_suffix('.stl')
                material = materials[visual.find('material').get('name')]
                key = (str(source), material)
                if key not in cache:
                    positions, faces, original = read_stl(source)
                    error = 0.0
                    max_error = 0.04 if '_ink' in source.stem else 0.35 if source.stem.startswith('hull_') else 0.15
                    if len(faces) > 4000:
                        positions.astype('<f4').tofile(directory / 'positions.bin')
                        faces.astype('<u4').tofile(directory / 'indices.bin')
                        target = max(1000, int(len(faces) * 0.06))
                        output = subprocess.run([
                            'node', str(WEB / 'tools/simplify-boat-mesh.mjs'), str(args.meshoptimizer.resolve()),
                            str(directory), str(target), str(max_error),
                        ], check=True, capture_output=True, text=True)
                        error = json.loads(output.stdout)['errorMm']
                        faces = np.fromfile(directory / 'simplified.bin', dtype='<u4').reshape(-1, 3)
                    positions, faces = preserve_hard_edges(positions, faces)
                    primitives = []
                    # WebGL 1 无须 OES_element_index_uint：每片最多 60000 个独立顶点。
                    groups = [faces] if len(positions) <= 65535 else [faces[i:i + 20000] for i in range(0, len(faces), 20000)]
                    for group in groups:
                        used, indices = np.unique(group, return_inverse=True)
                        points = positions[used].astype('<f4')
                        indices = indices.reshape(-1).astype('<u2')
                        primitives.append({'attributes': {'POSITION': accessor(points, 5126, 'VEC3', 34962)},
                                           'indices': accessor(indices, 5123, 'SCALAR', 34963), 'material': material})
                    cache[key] = len(document['meshes'])
                    document['meshes'].append({'name': source.stem, 'primitives': primitives})
                    entry = {'mesh': source.stem, 'sourceTriangles': original, 'triangles': len(faces), 'errorMm': round(error, 6)}
                    report.append(entry)
                    print(json.dumps(entry), flush=True)
                transform = origin(visual.find('origin')) @ np.diag(vector(mesh, 'scale', '1 1 1') + [1])
                node = {'name': visual.get('name', source.stem), 'mesh': cache[key], 'matrix': transform.flatten(order='F').tolist()}
                document['nodes'][links[link.get('name')]]['children'].append(len(document['nodes']))
                document['nodes'].append(node)
                visual_count += 1

    document['asset']['extras'].update(linkCount=len(links), visualCount=visual_count, meshReport=report)
    document['buffers'] = [{'byteLength': len(binary)}]
    description = json.dumps(document, separators=(',', ':'), ensure_ascii=True).encode('utf8')
    description += b' ' * (-len(description) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    size = 12 + 8 + len(description) + 8 + len(binary)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(struct.pack('<III', 0x46546C67, 2, size)
                            + struct.pack('<II', len(description), 0x4E4F534A) + description
                            + struct.pack('<II', len(binary), 0x004E4942) + binary)
    print(json.dumps({'output': str(args.output), 'bytes': size, 'links': len(links), 'visuals': visual_count,
                      'uniqueTriangles': sum(item['triangles'] for item in report)}))


if __name__ == '__main__':
    main()

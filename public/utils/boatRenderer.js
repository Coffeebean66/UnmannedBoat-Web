/* 微信 Canvas WebGL 1 船体与程序化水面；所有网格只在初始化时上传。 */
const { DEG, identity, multiply, quaternionMatrix, perspective, lookAt } = require('./boatAttitude');

const VERTEX = `
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_viewProjection;
varying vec3 v_position;
varying vec3 v_normal;
void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_position = world.xyz;
  v_normal = mat3(u_model) * a_normal;
  gl_Position = u_viewProjection * world;
}`;
const FRAGMENT = `
precision mediump float;
uniform vec4 u_color;
uniform vec3 u_eye;
uniform float u_unlit;
uniform float u_metallic;
uniform float u_roughness;
varying vec3 v_position;
varying vec3 v_normal;
void main() {
  vec3 normal = normalize(v_normal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 light = normalize(vec3(0.5, 0.9, 0.6));
  vec3 halfDirection = normalize(light + normalize(u_eye - v_position));
  float diffuse = max(dot(normal, light), 0.0);
  float specular = pow(max(dot(normal, halfDirection), 0.0), mix(64.0, 6.0, u_roughness));
  vec3 color = u_color.rgb * (0.38 + 0.62 * diffuse);
  color += mix(vec3(0.08), u_color.rgb, u_metallic) * specular * 0.28;
  color = pow(max(color, vec3(0.0)), vec3(0.454545));
  gl_FragColor = vec4(mix(color, u_color.rgb, u_unlit), u_color.a);
}`;

// 水面只用两个三角形，波纹/高光在着色器里计算，不额外加载纹理或模拟船体运动。
const WATER_VERTEX = `
attribute vec3 a_position;
uniform mat4 u_viewProjection;
varying vec3 v_position;
void main() {
  v_position = a_position;
  gl_Position = u_viewProjection * vec4(a_position, 1.0);
}`;
const WATER_FRAGMENT = `
precision mediump float;
uniform float u_time;
uniform vec3 u_eye;
varying vec3 v_position;
void main() {
  vec2 p = v_position.xz;
  float swellA = dot(p, vec2(3.2, 2.1)) - u_time * 1.2;
  float swellB = dot(p, vec2(-1.7, 4.4)) + u_time * 0.8;
  float rippleA = sin(dot(p, vec2(18.0, 12.0)) - u_time * 0.6);
  float rippleB = sin(dot(p, vec2(-13.0, 22.0)) + u_time * 0.4);
  vec2 slope = vec2(3.2, 2.1) * (0.018 * cos(swellA))
    + vec2(-1.7, 4.4) * (0.012 * cos(swellB));
  vec3 normal = normalize(vec3(-slope.x + 0.025 * rippleA, 1.0, -slope.y + 0.02 * rippleB));
  vec3 view = normalize(u_eye - v_position);
  vec3 light = normalize(vec3(-0.45, 0.9, 0.3));
  float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);
  float shine = pow(max(dot(normal, normalize(light + view)), 0.0), 80.0);
  float wave = 0.5 + 0.25 * sin(swellA) + 0.25 * sin(swellB);
  vec3 color = mix(vec3(0.018, 0.12, 0.18), vec3(0.055, 0.30, 0.34), wave);
  color += vec3(0.08, 0.20, 0.24) * fresnel;
  color += vec3(0.45, 0.76, 0.78) * shine * 0.65;
  float streak = dot(p, vec2(12.0, 9.0)) - u_time * 0.6 + 1.3 * sin(swellB);
  float glint = pow(0.5 + 0.5 * sin(streak), 16.0);
  color += vec3(0.028, 0.07, 0.08) * glint * (0.35 + 0.65 * wave);
  vec2 underBoat = p / vec2(1.5, 0.8);
  color *= 1.0 - 0.18 * exp(-dot(underBoat, underBoat) * 2.0);
  float edge = 1.0 - smoothstep(3.5, 7.5, length(p));
  gl_FragColor = vec4(color, 0.88 * edge);
}`;

class BoatRenderer {
  constructor(canvas, model) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: true });
    if (!this.gl) throw new Error('当前设备无法显示 3D 模型');
    this.buffers = [];
    this.shaders = [];
    this.programs = [];
    this.meshes = [];
    this.resetCamera();
    const gl = this.gl;
    try {
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        this.shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('3D 绘制初始化失败');
        return shader;
      };
      const link = (vertex, fragment) => {
        const program = gl.createProgram();
        this.programs.push(program);
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('3D 绘制初始化失败');
        return program;
      };
      this.program = link(VERTEX, FRAGMENT);
      this.locations = {};
      for (const name of ['model', 'viewProjection', 'color', 'eye', 'unlit', 'metallic', 'roughness'])
        this.locations[name] = gl.getUniformLocation(this.program, `u_${name}`);
      this.position = gl.getAttribLocation(this.program, 'a_position');
      this.normal = gl.getAttribLocation(this.program, 'a_normal');
      this.meshes = model.primitives.map(mesh => ({ ...mesh,
        vertices: this.buffer(gl.ARRAY_BUFFER, mesh.positions),
        normalBuffer: this.buffer(gl.ARRAY_BUFFER, mesh.normals),
        indexBuffer: this.buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices), count: mesh.indices.length
      }));
      const grid = [];
      for (let i = -6; i <= 6; i += 1) {
        const value = i * 0.3;
        grid.push(-1.8, -0.48, value, 1.8, -0.48, value, value, -0.48, -1.8, value, -0.48, 1.8);
      }
      this.grid = this.buffer(gl.ARRAY_BUFFER, new Float32Array(grid));
      this.gridCount = grid.length / 3;
      this.waterProgram = link(WATER_VERTEX, WATER_FRAGMENT);
      this.waterLocations = {};
      for (const name of ['viewProjection', 'eye', 'time'])
        this.waterLocations[name] = gl.getUniformLocation(this.waterProgram, `u_${name}`);
      this.waterPosition = gl.getAttribLocation(this.waterProgram, 'a_position');
      // 水平面固定在场景中，不随姿态旋转；按船模水线适配水下推进器。
      const waterY = Number.isFinite(model.waterLevel) ? model.waterLevel : -0.16;
      this.water = this.buffer(gl.ARRAY_BUFFER, new Float32Array([
        -8, waterY, -8, -8, waterY, 8, 8, waterY, -8,
        8, waterY, -8, -8, waterY, 8, 8, waterY, 8
      ]));
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE); // 船模含双面甲板和天线，背面也要可见。
      gl.clearColor(0.027, 0.078, 0.114, 1);
    } catch (error) { this.dispose(); throw error; }
  }

  buffer(target, data) {
    const gl = this.gl, buffer = gl.createBuffer();
    if (!buffer) throw new Error('3D 显存不足');
    this.buffers.push(buffer);
    gl.bindBuffer(target, buffer); gl.bufferData(target, data, gl.STATIC_DRAW);
    return buffer;
  }

  resetCamera() { this.cameraYaw = 42; this.cameraPitch = 30; }

  orbit(dx, dy) {
    this.cameraYaw -= dx * 0.45;
    this.cameraPitch = Math.max(8, Math.min(80, this.cameraPitch + dy * 0.35));
  }

  draw(quaternion, { waterEnabled = true, time = 0 } = {}) {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost && gl.isContextLost()) throw new Error('3D 画面已暂停，请重新加载');
    const yaw = this.cameraYaw * DEG, pitch = this.cameraPitch * DEG, distance = 4.8;
    const eye = [distance * Math.cos(pitch) * Math.cos(yaw), distance * Math.sin(pitch),
      distance * Math.cos(pitch) * Math.sin(yaw)];
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    const viewProjection = multiply(perspective(this.canvas.width / this.canvas.height), lookAt(eye));
    gl.uniformMatrix4fv(this.locations.viewProjection, false, viewProjection);
    gl.uniform3fv(this.locations.eye, eye);
    gl.enableVertexAttribArray(this.position);
    if (!waterEnabled) {
      gl.disableVertexAttribArray(this.normal);
      gl.vertexAttrib3f(this.normal, 0, 1, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.grid);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(this.locations.model, false, identity());
      gl.uniform4fv(this.locations.color, [0.08, 0.22, 0.28, 1]);
      gl.uniform1f(this.locations.unlit, 1);
      gl.drawArrays(gl.LINES, 0, this.gridCount);
    }
    gl.uniform1f(this.locations.unlit, 0);
    gl.uniformMatrix4fv(this.locations.model, false, quaternionMatrix(quaternion));
    gl.enableVertexAttribArray(this.normal);
    for (const mesh of this.meshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
      gl.vertexAttribPointer(this.normal, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.uniform4fv(this.locations.color, mesh.color);
      gl.uniform1f(this.locations.metallic, mesh.metallic);
      gl.uniform1f(this.locations.roughness, mesh.roughness);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    if (waterEnabled) this.drawWater(viewProjection, eye, time);
  }

  drawWater(viewProjection, eye, time) {
    const gl = this.gl;
    gl.useProgram(this.waterProgram);
    gl.uniformMatrix4fv(this.waterLocations.viewProjection, false, viewProjection);
    gl.uniform3fv(this.waterLocations.eye, eye);
    // 所有波纹速率都是 0.2 的整数倍，按共同周期回绕可避免长时间运行后的精度下降。
    gl.uniform1f(this.waterLocations.time, Number.isFinite(time) ? Math.max(0, time) % (Math.PI * 10) : 0);
    gl.disableVertexAttribArray(this.normal);
    gl.enableVertexAttribArray(this.waterPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.water);
    gl.vertexAttribPointer(this.waterPosition, 3, gl.FLOAT, false, 0, 0);
    // 先画船再叠加半透明水面；水上部件由深度测试保留，水下船体透过水面可见。
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(this.waterPosition);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    for (const shader of this.shaders) this.gl.deleteShader(shader);
    for (const program of this.programs) this.gl.deleteProgram(program);
    this.buffers = []; this.shaders = []; this.programs = []; this.meshes = [];
  }
}

module.exports = { BoatRenderer };

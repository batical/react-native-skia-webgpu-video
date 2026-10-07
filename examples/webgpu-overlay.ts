import type { VideoFrame } from "../src/types";
import type { VideoFrameProcessor } from "../src/exportVideoComposition";
import { createVideoGpuScope } from "../src/gpu";
import {
  GPUBufferUsage,
  GPUShaderStage,
  GPUTextureUsage,
} from "react-native-webgpu";

// Original minimal 3D example: one color target, one depth target, one uniform
// buffer, reused for the whole export. Draw frames['gpu-overlay'] with
// drawVideoFrame in the existing synchronous drawFrame callback.
const cubeShader = `
struct Params { value: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
struct Vertex { @builtin(position) position: vec4f, @location(0) color: vec3f };
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Vertex {
  let points = array<vec3f,8>(
    vec3f(-1,-1,-1), vec3f(1,-1,-1), vec3f(1,1,-1), vec3f(-1,1,-1),
    vec3f(-1,-1,1), vec3f(1,-1,1), vec3f(1,1,1), vec3f(-1,1,1));
  let indices = array<u32,36>(
    0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,
    3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5);
  let p = points[indices[index]] * 0.65;
  let t = params.value.x;
  let q = vec3f(cos(t)*p.x+sin(t)*p.z, p.y, -sin(t)*p.x+cos(t)*p.z);
  let r = vec3f(q.x, cos(t*0.7)*q.y-sin(t*0.7)*q.z, sin(t*0.7)*q.y+cos(t*0.7)*q.z);
  let z = r.z+3.0;
  var out: Vertex;
  out.position = vec4f(r.x/params.value.y, r.y, (z-0.1)*10.0/9.9, z);
  out.color = (p+vec3f(0.65))/1.3;
  return out;
}
@fragment fn fragmentMain(input: Vertex) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}`;

export const createCubeOverlay = async ({
  width,
  height,
}: {
  width: number;
  height: number;
}): Promise<VideoFrameProcessor> => {
  "worklet";
  const scope = createVideoGpuScope({ maxResources: 3 });
  try {
    const color = scope.createTexture({ width, height, label: "3D color" });
    const depth = scope.createTexture({
      width,
      height,
      format: "depth24plus",
      skia: "none",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      label: "3D depth",
    });
    const uniform = scope.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "3D time",
    });
    const device = scope.device;
    const module = device.createShaderModule({ code: cubeShader });
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vertexMain" },
      fragment: {
        module,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    const binding = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    // Worklets capture primitive bindings separately. Share an object so the
    // cleanup observes the last map published by prepareFrame.
    const output: { published: Record<string, VideoFrame> | null } = { published: null };
    return {
      prepareFrame: ({ frames, currentTime, isCancelled }) => {
        "worklet";
        if (isCancelled()) return;
        device.queue.writeBuffer(
          uniform,
          0,
          new Float32Array([currentTime, width / height, 0, 0]),
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: color.texture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          depthStencilAttachment: {
            view: depth.texture.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, binding);
        pass.draw(36);
        pass.end();
        device.queue.submit([encoder.finish()]);
        // Ordered with Skia on the SAME queue/device. No per-frame texture or
        // image allocation; export flush/readback is the synchronization point.
        output.published = frames;
        frames["gpu-overlay"] = {
          width,
          height,
          rotation: 0,
          texture: { kind: "skia-image", image: color.image },
        };
      },
      dispose: () => {
        "worklet";
        if (output.published) delete output.published["gpu-overlay"];
        output.published = null;
        return scope.dispose();
      },
    };
  } catch (error) {
    await scope.dispose();
    throw error;
  }
};

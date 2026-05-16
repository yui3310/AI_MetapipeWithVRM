import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import * as Kalidokit from 'kalidokit';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'; 
import { GammaCorrectionShader } from 'three/addons/shaders/GammaCorrectionShader.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';

// --- Memory Optimization: Pre-allocate Math Objects ---
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _currentDir = new THREE.Vector3();
const _restDir = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _targetChest = new THREE.Quaternion();
const _shoulderDir = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _hipsPos = new THREE.Vector3();
const _dummyQ = new THREE.Quaternion(); // 計算角度用
let recorder;
let recordedChunks = [];
let recording = false;
const clock = new THREE.Clock();

const state = {
    vrm: null,
    mode: 'none', 
    videoSource: null, 
    mapping: {}, 
    mediapipeHolistic: null,
    isProcessing: false,
    lastLogTime: 0,
    testAttention: false,
    testZombie: false,
    testForward: false,
    testBackward: false,
    testHandsOnHips: false,
    testArmLoop: false,
    testLeftHand: false,
    testLegCurl: false,
    smoothness: 0.5, // 預設值改為 0.5 (配合自適應算法)
    bgColor: '#1a1a1a',
    isRecordingMotion: false,
    motionFrames: [], // 儲存錄製的動作數據
    enableEyeTracking: false,
    previewVisible: true,
    enableLegTracking: false,
    
    mirror: {
        arms: { x: 1, y: 1, z: 1 },
        legs: { x: 1, y: 1, z: 1 }
    },

    calibration: {
        active: false,
        poseDirs: {}
    }
};

let vmcSocket = null;
let isVmcActive = false;

function toggleVMC() {
    const vmcBtn = getEl('vmc-btn');
    if (!isVmcActive) {
        // 嘗試連線到本地的 Node.js 伺服器
        vmcSocket = new WebSocket('ws://localhost:8080');
        
        vmcSocket.onopen = () => {
            isVmcActive = true;
            vmcBtn.innerText = "🔴 停止 VMC 廣播";
            vmcBtn.classList.replace('bg-purple-600', 'bg-red-600');
            showMessage("VMC 伺服器連線成功！開始廣播數據", false);
        };
        
        vmcSocket.onerror = () => {
            showMessage("VMC 連線失敗，請確認已執行 node server.js");
        };
        
        vmcSocket.onclose = () => {
            isVmcActive = false;
            vmcBtn.innerText = "📡 啟動 VMC 廣播";
            vmcBtn.classList.replace('bg-red-600', 'bg-purple-600');
        };
    } else {
        if (vmcSocket) vmcSocket.close();
    }
}

// 將骨骼數據轉為 VMC 協定發送
// 將骨骼數據轉為 VMC 協定發送 (修正強型別 Float 問題)
function broadcastVMC() {
    if (!isVmcActive || !state.vrm || vmcSocket.readyState !== WebSocket.OPEN) return;

    // 1. 發送 Root 位置
    const hipsNode = state.vrm.humanoid.getNormalizedBoneNode('hips');
    if (hipsNode) {
        const rootMsg = {
            address: "/VMC/Ext/Root/Pos",
            args: [
                { type: "s", value: "root" }, 
                { type: "f", value: hipsNode.position.x || 0 }, 
                { type: "f", value: hipsNode.position.y || 0 }, 
                { type: "f", value: hipsNode.position.z || 0 }, 
                { type: "f", value: hipsNode.quaternion.x || 0 }, 
                { type: "f", value: hipsNode.quaternion.y || 0 }, 
                { type: "f", value: hipsNode.quaternion.z || 0 }, 
                { type: "f", value: hipsNode.quaternion.w || 1 }
            ]
        };
        vmcSocket.send(JSON.stringify(rootMsg));
    }

    // 2. 發送所有骨骼的旋轉數據 (強制指定 Float 型別)
    VRM_BONE_LIST.forEach(boneName => {
        const node = state.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (node) {
            const vmcBoneName = boneName.charAt(0).toUpperCase() + boneName.slice(1);
            
            const boneMsg = {
                address: "/VMC/Ext/Bone/Pos",
                args: [
                    { type: "s", value: vmcBoneName },
                    { type: "f", value: 0 }, // 強制將 0 轉為 Float (0.0)
                    { type: "f", value: 0 }, 
                    { type: "f", value: 0 }, 
                    { type: "f", value: node.quaternion.x || 0 }, 
                    { type: "f", value: node.quaternion.y || 0 }, 
                    { type: "f", value: node.quaternion.z || 0 }, 
                    { type: "f", value: node.quaternion.w || 1 }
                ]
            };
            vmcSocket.send(JSON.stringify(boneMsg));
        }
    });

    // 3. 發送表情 BlendShape
    const blendShape = state.vrm.expressionManager;
    if (blendShape) {
        const blinkVal = blendShape.getValue('blink') || 0;
        const aaVal = blendShape.getValue('aa') || 0;
        
        vmcSocket.send(JSON.stringify({ 
            address: "/VMC/Ext/Blend/Val", 
            args: [{ type: "s", value: "Blink" }, { type: "f", value: blinkVal }] 
        }));
        vmcSocket.send(JSON.stringify({ 
            address: "/VMC/Ext/Blend/Val", 
            args: [{ type: "s", value: "A" }, { type: "f", value: aaVal }] 
        }));
        vmcSocket.send(JSON.stringify({ address: "/VMC/Ext/Blend/Apply", args: [] })); 
    }
}

function getSupportedMimeType() {
    const types = [
        "video/webm; codecs=vp9",
        "video/webm; codecs=vp8",
        "video/webm",
        "video/mp4"
    ];
    for (let type of types) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
}

// ... (Bone Lists and Helpers remain the same) ...
const KALIDOKIT_MAP = {
    'HIPS': 'hips', 'SPINE': 'spine', 'CHEST': 'chest', 'NECK': 'neck', 'HEAD': 'head',
    'LEFT_SHOULDER': 'leftUpperArm', 'RIGHT_SHOULDER': 'rightUpperArm',
    'LEFT_ELBOW': 'leftLowerArm', 'RIGHT_ELBOW': 'rightLowerArm',
    'LEFT_WRIST': 'leftHand', 'RIGHT_WRIST': 'rightHand',
    'LEFT_HIP': 'leftUpperLeg', 'RIGHT_HIP': 'rightUpperLeg',
    'LEFT_KNEE': 'leftLowerLeg', 'RIGHT_KNEE': 'rightLowerLeg',
    'LEFT_ANKLE': 'leftFoot', 'RIGHT_ANKLE': 'rightFoot'
};

const VRM_BONE_LIST = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
    'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
    'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
    'leftFoot', 'rightFoot', 'leftToes', 'rightToes',
    'leftThumbProximal', 'leftThumbIntermediate', 'leftThumbDistal', 'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
    'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal', 'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
    'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
    'rightThumbProximal', 'rightThumbIntermediate', 'rightThumbDistal', 'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
    'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal', 'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
    'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'
];

const getEl = (id) => document.getElementById(id);

function showMessage(text, isError = true) {
    const box = getEl('msg-box');
    if (!box) return;
    box.innerText = text;
    box.style.background = isError ? '#ef4444' : '#10b981';
    box.style.display = 'block';
    setTimeout(() => { if(box) box.style.display = 'none'; }, 3000);
}

Object.keys(KALIDOKIT_MAP).forEach(k => {
    state.mapping[k] = 'J_' + KALIDOKIT_MAP[k].charAt(0).toUpperCase() + KALIDOKIT_MAP[k].slice(1);
});

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 柔和邊緣陰影
renderer.toneMapping = THREE.ACESFilmicToneMapping; // 電影級色調
renderer.toneMappingExposure = 0.8;

const container = getEl('canvas-container');
if (container) container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
const camera = new THREE.PerspectiveCamera(35, window.innerWidth/window.innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.update();

scene.add(new THREE.AmbientLight(0x2a3040, 0.8)); 

// 2. 主光源 (DirectionalLight)
// 改為「暖黃色」，模擬天花板那顆巨大燈籠的光源
const dirLight = new THREE.DirectionalLight(0xffe6cc, 2.5); 
dirLight.position.set(0, 10, 2); // 移到正上方偏前，往下打光
dirLight.castShadow = true; 

// 高畫質陰影貼圖設定保持不變
dirLight.shadow.mapSize.width = 2048; 
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 25;
dirLight.shadow.camera.left = -10; // 擴大陰影覆蓋範圍
dirLight.shadow.camera.right = 10;
dirLight.shadow.camera.top = 10;
dirLight.shadow.camera.bottom = -10;
dirLight.shadow.bias = -0.0005; 
scene.add(dirLight);

state.mediapipeHolistic = new Holistic({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`
});
state.mediapipeHolistic.setOptions({ 
    modelComplexity: 1,
    selfieMode: true,
    smoothLandmarks: true, // MediaPipe 內建平滑
    refineFaceLandmarks: true,
    minDetectionConfidence: 0.7, // 提高信心閾值，過濾雜訊
    minTrackingConfidence: 0.7 
});


// --- Post-Processing Setup ---
const renderScene = new RenderPass(scene, camera);

const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 16;      // 陰影擴散範圍 (越大越柔和)
ssaoPass.minDistance = 0.005;    // 開始計算陰影的最小距離
ssaoPass.maxDistance = 0.1;      // 陰影影響的最大距離

const ssrPass = new SSRPass({
    renderer,
    scene,
    camera,
    width: window.innerWidth,
    height: window.innerHeight,
    thickness: 0.05,     // 深度厚度容差 (解決反射穿模問題)
    maxDistance: 3,      // 反射的最遠距離
    opacity: 0.8         // 反射的整體透明度 (強度)
});

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 
    1.5, 0.4, 0.85
);
bloomPass.strength = 0; 
bloomPass.radius = 0.5;   
bloomPass.threshold = 0.85; 
const gammaCorrectionPass = new ShaderPass(GammaCorrectionShader);
const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(ssrPass);
composer.addPass(ssaoPass);
composer.addPass(bloomPass);
composer.addPass(gammaCorrectionPass); 

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

function captureMotionFrame() {
    if (!state.vrm || !state.isRecordingMotion) return;

    const frame = {
        time: performance.now(),
        bones: {}
    };

    // 遍歷所有 Humanoid 骨骼擷取旋轉值
    VRM_BONE_LIST.forEach(boneName => {
        const node = state.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (node) {
            frame.bones[boneName] = {
                x: node.rotation.x,
                y: node.rotation.y,
                z: node.rotation.z,
                w: node.rotation.w // 建議存四元數 Quaternion
            };
        }
    });

    state.motionFrames.push(frame);
}

function stopRecording() {

    if (!recorder) return;

    recorder.stop();
    recording = false;

    showMessage("錄製完成", false);
}

function saveRecording() {
    // 使用當前錄製器實際採用的格式
    const blob = new Blob(recordedChunks, {
        type: recorder.mimeType || "video/webm"
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const extension = recorder.mimeType.includes("mp4") ? "mp4" : "webm";
    
    a.href = url;
    a.download = `vrm-capture-${Date.now()}.${extension}`;
    a.click();

    URL.revokeObjectURL(url);
}
state.mediapipeHolistic.onResults((results) => {
    const previewCanvas = getEl('preview-canvas');
    const sourceVideo = state.videoSource;

    if (previewCanvas && sourceVideo && sourceVideo.readyState >= 2) {
        if (previewCanvas.width !== sourceVideo.videoWidth) {
            previewCanvas.width = sourceVideo.videoWidth;
            previewCanvas.height = sourceVideo.videoHeight;
        }
        const ctx = previewCanvas.getContext('2d', { alpha: true });
        ctx.save();
        ctx.translate(previewCanvas.width, 0);
        ctx.scale(-1, 1);
        ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

        if (results.poseLandmarks) {
            drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#00ff00', lineWidth: 4 });
            drawLandmarks(ctx, results.poseLandmarks, { color: '#ff0000', radius: 3 });
        }
        if (results.faceLandmarks) {
            drawConnectors(ctx, results.faceLandmarks, FACEMESH_TESSELATION, { color: '#1e90ff', lineWidth: 1 });
        }
        if (results.leftHandLandmarks) {
            drawConnectors(ctx, results.leftHandLandmarks, HAND_CONNECTIONS, { color: '#00cc00', lineWidth: 2 });
            drawLandmarks(ctx, results.leftHandLandmarks, { color: '#ffffff', radius: 2 });
        }
        if (results.rightHandLandmarks) {
            drawConnectors(ctx, results.rightHandLandmarks, HAND_CONNECTIONS, { color: '#00cc00', lineWidth: 2 });
            drawLandmarks(ctx, results.rightHandLandmarks, { color: '#ffffff', radius: 2 });
        }
        ctx.restore();
    }

    state.lastPoseLandmarks = results.poseWorldLandmarks || results.poseLandmarks;

    const isTesting = state.testAttention || state.testZombie || state.testForward ||
        state.testBackward || state.testHandsOnHips ||
        state.testArmLoop || state.testLeftHand || state.testLegCurl;

    if (!results.poseLandmarks || !state.vrm || isTesting) return;

    animateVRM(
        results.poseWorldLandmarks || results.poseLandmarks, 
        results.faceLandmarks,
        results.leftHandLandmarks,   // 餵入左手特徵點
        results.rightHandLandmarks   // 餵入右手特徵點
    );
});

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function loadVRM(url) {
    const loaderEl = getEl('loading-indicator');
    if (loaderEl) loaderEl.style.display = 'block';
    loader.load(url, (gltf) => {
        const vrm = gltf.userData.vrm;
        if (state.vrm) {
            scene.remove(state.vrm.scene); 
            VRMUtils.deepDispose(state.vrm.scene); 
        }
        VRMUtils.rotateVRM0(vrm);
        state.vrm = vrm;

        vrm.scene.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        scene.add(vrm.scene);
        if (loaderEl) loaderEl.style.display = 'none';
        if (getEl('status-text')) getEl('status-text').innerText = "模型載入成功";
        state.faceTess = initFaceTesselation(scene);
    }, undefined, (err) => {
        console.error("VRM Load Error:", err);
        showMessage("模型載入失敗，請檢查網路。");
    });
}

function initFaceTesselation(scene) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(FACEMESH_TESSELATION.length * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x1e90ff, transparent: true, opacity: 0.9 });
    const mesh = new THREE.LineSegments(geometry, material);
    scene.add(mesh);
    return mesh;
}

function convert(l, target) {
    target.set(
        -(l.x - 0.5) * 2,
        -(l.y - 0.5) * 2,
        -l.z
    );
}

// --- 🔥 核心優化：自適應平滑演算法 ---
// 根據「目標角度」與「當前角度」的差異，動態決定平滑係數
// 差異大 = 動作快 = 減少平滑 (反應快)
// 差異小 = 動作慢 = 增加平滑 (去抖動)
function adaptiveSlerp(node, targetQuat, baseSmoothness) {
    const angle = node.quaternion.angleTo(targetQuat); // 計算差異角度(弧度)
    
    // 放大角度差異，讓它對微小變動更敏感
    // 值越小越平滑(慢)，值越大越即時(快)
    let dynamicFactor = baseSmoothness * (1 + angle * 15); 
    
    // 限制範圍：最慢 0.02 (極穩)，最快 0.8 (極快)
    dynamicFactor = THREE.MathUtils.clamp(dynamicFactor, 0.02, 0.8);
    
    node.quaternion.slerp(targetQuat, dynamicFactor);
}

function controlBone(vrm, key, lm3D, n1, n2, basis) {
    if (!lm3D[n1] || !lm3D[n2]) return;

    const visibility = lm3D[n2].visibility || 0; 

    if (visibility < 0.5) {
        const node = vrm.humanoid.getNormalizedBoneNode(key);
        if (node) {
            if (key.toLowerCase().includes("upperarm")) {
                // 1. 大臂：從 T-Pose 方向旋轉到「目標方向」
                _v1.set(basis[0], basis[1], basis[2]); 
                
                // 如果之前 -1 是舉手，這裡改用 1 就會變成垂下 (立正)
                _v2.set(0, 1, 0); 
                
                _dummyQ.setFromUnitVectors(_v1, _v2);  
                adaptiveSlerp(node, _dummyQ, 0.05);
            } else {
                // 2. 小臂：回歸 0 旋轉（相對於大臂伸直）
                adaptiveSlerp(node, new THREE.Quaternion(), 0.05);
            }
        }
        return;
    }

    convert(lm3D[n1], _v1);
    convert(lm3D[n2], _v2);
    _currentDir.subVectors(_v2, _v1).normalize();

    // --- 校準修正（安全版，不會 freeze） ---
    if (state.calibration.active && state.calibration.poseDirs[key]) {

        const calibQ = state.calibration.poseDirs[key];

        // currentDir → quaternion
        _dummyQ.setFromUnitVectors(_worldForward, _currentDir);

        // 套用相對校準
        _dummyQ.premultiply(calibQ.clone().invert());

        // 再轉回方向向量
        _currentDir
            .set(0, 1, 0)
            .applyQuaternion(_dummyQ)
            .normalize();
    }

    let mirrorMult = { x: 1, y: 1, z: 1 };
    if (key.toLowerCase().includes('arm') || key.toLowerCase().includes('hand')) {
        mirrorMult = state.mirror.arms;
    } else if (key.toLowerCase().includes('leg') || key.toLowerCase().includes('foot')) {
        mirrorMult = state.mirror.legs;
    }
    _currentDir.x *= mirrorMult.x;
    _currentDir.y *= mirrorMult.y;
    _currentDir.z *= mirrorMult.z;

    if (!state.calibration.active && key.includes("Arm")) { _currentDir.z *= -1; _currentDir.y *= -1; }
    if (!state.calibration.active && key.includes("Leg")) { _currentDir.x *= -1; }

    _restDir.set(basis[0], basis[1], basis[2]);

    _targetQuat.setFromUnitVectors(_restDir, _currentDir);

    const node = vrm.humanoid.getNormalizedBoneNode(key);
    if (node) {
        // 使用新的自適應平滑
        adaptiveSlerp(node, _targetQuat, state.smoothness * 0.1); 
    }
}

const _handEuler = new THREE.Euler();
const _handQuat = new THREE.Quaternion();

function applyHandRig(handRig, side) {
    if (!handRig) return;
    const sideLower = side.toLowerCase(); 
    
    const fingers = [
        "Wrist", 
        "ThumbProximal", "ThumbIntermediate", "ThumbDistal", 
        "IndexProximal", "IndexIntermediate", "IndexDistal",
        "MiddleProximal", "MiddleIntermediate", "MiddleDistal",
        "RingProximal", "RingIntermediate", "RingDistal",
        "LittleProximal", "LittleIntermediate", "LittleDistal"
    ];
    
    fingers.forEach(finger => {
        const rigKey = side + finger; 
        const vrmBoneName = finger === "Wrist" ? `${sideLower}Hand` : `${sideLower}${finger}`;
        
        const node = state.vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
        const rotation = handRig[rigKey];
        
        if (node && rotation) {
            const fingerSensitivity = 1.8;
            let rotX = rotation.x * -1 * fingerSensitivity;
            let rotY = rotation.y * -1; 
            let rotZ = rotation.z * -1; 

            if (finger.includes("Thumb")) {
                // 由於不同建模軟體匯出的 VRM 大拇指座標系可能略有差異，
                // 通常取消 Z 軸或 Y 軸的 -1 反轉，就能讓大拇指往手心內彎。
                if (side === "Left") {
                    rotX = rotation.x * fingerSensitivity;
                    rotY = rotation.y;       // 取消 -1
                    rotZ = rotation.z;       // 取消 -1，讓左大拇指向內凹
                } else {
                    rotX = rotation.x * fingerSensitivity;
                    rotY = rotation.y * -1;  
                    rotZ = rotation.z;       // 右大拇指通常也需要取消 -1
                }
            }
            
            if (finger === "Wrist") {
                rotZ = 0; // 完全鎖定翻轉 (Roll)，防止手肘因深度誤判而旋轉崩潰
                rotY = THREE.MathUtils.clamp(rotY, -0.1, 0.1); // 限制左右擺動，保持手掌穩定
                rotX = THREE.MathUtils.clamp(rotX, -0.3, 0.3); // 限制上下擺動
                
                // 讓手掌的旋轉反應更平滑
                _handEuler.set(rotX, rotY, rotZ, 'XYZ');
                _handQuat.setFromEuler(_handEuler);
                adaptiveSlerp(node, _handQuat, state.smoothness * 0.05); 
                return;
            }

            // 將修正後的角度套用進 Euler (設定旋轉順序為 XYZ)
            _handEuler.set(rotX, rotY, rotZ, 'XYZ');
            _handQuat.setFromEuler(_handEuler);
            
            adaptiveSlerp(node, _handQuat, state.smoothness * 0.5);
        }
    });
}

function animateVRM(lm3D, faceLandmarks, leftHand, rightHand) {
    if (!state.vrm || !lm3D) return;

    convert(lm3D[11], _v1); 
    convert(lm3D[12], _v2); 
    _shoulderDir.subVectors(_v2, _v1).normalize();
    
    const chestNode = state.vrm.humanoid.getNormalizedBoneNode('chest');
    if (chestNode) {
        _targetChest.setFromUnitVectors(_xAxis, _shoulderDir);
        adaptiveSlerp(chestNode, _targetChest, state.smoothness * 0.1);
    }

    // --- 🔥 核心優化：臀部穩定 (避免人物亂飄) ---
    const hipsNode = state.vrm.humanoid.getNormalizedBoneNode('hips');
    if (hipsNode && lm3D[23] && lm3D[24]) {
        const l = lm3D[23];
        const r = lm3D[24];
        
        let targetY;
        let targetZ = 0;

        if (state.enableLegTracking) {
            // 開啟時：動態計算高度 (下蹲會跟著降低)
            const height2D = 1.0 - (l.y + r.y) * 0.5;
            targetY = height2D * 0.6 + 0.8;
            targetZ = THREE.MathUtils.clamp(((l.z + r.z) * 0.5), -0.2, 0.2) * 0.05; 
        } else {
            // 關閉時：高度強制鎖死，不往前或往後偏移
            targetY = 0.95; 
            targetZ = 0;
        }

        _hipsPos.set(0, targetY, targetZ);
        hipsNode.position.lerp(_hipsPos, 0.1);
    }

    if (faceLandmarks) {
        const vw = state.videoSource?.videoWidth || 0;
        const vh = state.videoSource?.videoHeight || 0;

        const faceRig = Kalidokit.Face.solve(faceLandmarks, {
            runtime: "mediapipe",
            video: vw > 0 ? state.videoSource : null,
            imageSize: vw > 0 ? { width: vw, height: vh } : null
        });

        const exp = state.vrm.expressionManager;
        const humanoid = state.vrm.humanoid;

        if (exp && humanoid) {
            // --- 1. 原本的嘴部形狀控制 (保留不變) ---
            const mouthShapes = [
                { key: 'aa', val: faceRig.mouth.shape.A },
                { key: 'ih', val: faceRig.mouth.shape.I },
                { key: 'ou', val: faceRig.mouth.shape.U },
                { key: 'ee', val: faceRig.mouth.shape.E },
                { key: 'oh', val: faceRig.mouth.shape.O }
            ];
            mouthShapes.forEach(shape => {
                const currentVal = exp.getValue(shape.key) || 0;
                let targetVal = shape.val < 0.05 ? 0 : shape.val;
                exp.setValue(shape.key, THREE.MathUtils.lerp(currentVal, targetVal, 0.3));
            });

            // ▼▼▼ 2. 全新：智慧眨眼與眼球追蹤系統 ▼▼▼
            if (state.enableEyeTracking) {
                
                // 【A. 眨眼控制 (Blink)】
                // Kalidokit: 1 為全開，0 為全閉
                // VRM BlendShape: 0 為全開，1 為全閉 (需反轉數值)
                let blinkL = 1.0 - faceRig.eye.l;
                let blinkR = 1.0 - faceRig.eye.r;

                // 設立門檻值 (Deadzone)，避免眼睛半開半閉的無神狀態或抽搐
                const BLINK_THRESH = 0.3; // 低於此值視為完全睜眼
                const CLOSE_THRESH = 0.7; // 高於此值視為完全閉眼
                blinkL = blinkL < BLINK_THRESH ? 0 : (blinkL > CLOSE_THRESH ? 1 : blinkL);
                blinkR = blinkR < BLINK_THRESH ? 0 : (blinkR > CLOSE_THRESH ? 1 : blinkR);

                // 智慧同步：如果左右眼閉合程度差異不大，強制同步雙眼，避免變成奇怪的「拋媚眼」
                if (Math.abs(blinkL - blinkR) < 0.4) {
                    const maxBlink = Math.max(blinkL, blinkR);
                    blinkL = maxBlink;
                    blinkR = maxBlink;
                }

                // 平滑過渡眨眼動作
                const currentBlinkL = exp.getValue('blinkLeft') || exp.getValue('blink') || 0;
                const currentBlinkR = exp.getValue('blinkRight') || exp.getValue('blink') || 0;
                exp.setValue('blinkLeft', THREE.MathUtils.lerp(currentBlinkL, blinkL, 0.5));
                exp.setValue('blinkRight', THREE.MathUtils.lerp(currentBlinkR, blinkR, 0.5));
                exp.setValue('blink', 0); // 確保統籌的 blink 歸零，交由左右獨立控制

                // 【B. 眼球轉動控制 (Gaze / Pupil)】
                const leftEyeBone = humanoid.getNormalizedBoneNode('leftEye');
                const rightEyeBone = humanoid.getNormalizedBoneNode('rightEye');

                if (leftEyeBone && rightEyeBone) {
                    // 產生一個代表「零旋轉/看正前方」的四元數
                    const zeroQuat = new THREE.Quaternion(); 
                    
                    // 強制將眼球骨骼平滑鎖死在中間，避免亂飄
                    adaptiveSlerp(leftEyeBone, zeroQuat, 0.5);
                    adaptiveSlerp(rightEyeBone, zeroQuat, 0.5);
                }
            } else {
                // 如果在 UI 關閉眼睛追蹤：強制睜眼並將眼球歸回正中央
                exp.setValue('blink', 0);
                exp.setValue('blinkLeft', 0);
                exp.setValue('blinkRight', 0);
                const leftEyeBone = humanoid.getNormalizedBoneNode('leftEye');
                const rightEyeBone = humanoid.getNormalizedBoneNode('rightEye');
                const zeroQuat = new THREE.Quaternion();
                if (leftEyeBone) adaptiveSlerp(leftEyeBone, zeroQuat, 0.5);
                if (rightEyeBone) adaptiveSlerp(rightEyeBone, zeroQuat, 0.5);
            }
            // ▲▲▲ 新增結束 ▲▲▲

            // --- 3. 原本的頭部與脖子旋轉 (保留不變) ---
            const headNode = humanoid.getNormalizedBoneNode('head');
            const neckNode = humanoid.getNormalizedBoneNode('neck');
            if (headNode && neckNode) {
                const headQuat = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(faceRig.head.x, faceRig.head.y, faceRig.head.z, 'XYZ')
                );
                adaptiveSlerp(headNode, headQuat, state.smoothness * 0.1);
            }
        }
    }
    
    controlBone(state.vrm, 'leftUpperArm', lm3D, 11, 13, [-1, 0, 0]); 
    controlBone(state.vrm, 'leftLowerArm', lm3D, 13, 15, [-1, 0, 0]);
    controlBone(state.vrm, 'rightUpperArm', lm3D, 12, 14, [1, 0, 0]);
    controlBone(state.vrm, 'rightLowerArm', lm3D, 14, 16, [1, 0, 0]);
    if (state.enableLegTracking) {
        controlBone(state.vrm, 'leftUpperLeg', lm3D, 23, 25, [0, -1, 0]);
        controlBone(state.vrm, 'leftLowerLeg', lm3D, 25, 27, [0, -1, 0]);
        controlBone(state.vrm, 'rightUpperLeg', lm3D, 24, 26, [0, -1, 0]);
        controlBone(state.vrm, 'rightLowerLeg', lm3D, 26, 28, [0, -1, 0]);
    }

    // ▼▼▼ 新增：手指捕捉邏輯 ▼▼▼
    if (leftHand) {
        const leftRig = Kalidokit.Hand.solve(leftHand, "Left");
        applyHandRig(leftRig, "Left");
    }
    if (rightHand) {
        const rightRig = Kalidokit.Hand.solve(rightHand, "Right");
        applyHandRig(rightRig, "Right");
    }

    //state.vrm.update(0.016);
    captureMotionFrame();
    broadcastVMC();
}

function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();
    if (state.vrm) {
        state.vrm.update(deltaTime);
    }
    
    if (state.vrm && !state.isProcessing && state.videoSource && state.videoSource.readyState >= 2) {
        const isTesting = state.testAttention || state.testZombie || state.testForward || 
                          state.testBackward || state.testHandsOnHips || state.testArmLoop || 
                          state.testLeftHand || state.testLegCurl;

        if (!isTesting && (!state.videoSource.paused || state.mode === 'video')) {
            state.isProcessing = true;
            state.mediapipeHolistic.send({ image: state.videoSource })
                .then(() => state.isProcessing = false)
                .catch(() => state.isProcessing = false);
        }
    }
    composer.render();
}

function updateMouth(face) {
    const upperLip = face[13];
    const lowerLip = face[14];
    if (!upperLip || !lowerLip) return;
    const mouthOpen = Math.abs(upperLip.y - lowerLip.y);
    // 增加閾值，過濾掉閉嘴時的微小抖動
    const value = THREE.MathUtils.clamp((mouthOpen - 0.02) * 15, 0, 1);
    const blendShape = state.vrm.expressionManager;
    if (!blendShape) return;
    
    // 對嘴型也做一點平滑
    const currentAa = blendShape.getValue('aa');
    blendShape.setValue('aa', THREE.MathUtils.lerp(currentAa, value, 0.4));
}
function saveMotionData() {
    const dataStr = JSON.stringify(state.motionFrames);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motion_data_${Date.now()}.json`; // 下載 JSON 檔
    a.click();
}



const setupEventListeners = () => {

    // --- MMD PMX 單步式背景載入系統 (整包資料夾 + 強力貼圖修復) ---
    let pmxFile = null;
    let textureFiles = [];
    let currentPmxUrls = [];

    const btnSelectDir = getEl('btn-select-dir');
    const pmxDirUpload = getEl('pmx-dir-upload');
    const pmxStatus = getEl('pmx-status');
    const btnRemovePmx = getEl('btn-remove-pmx');

    if (btnSelectDir) {
        // 點擊按鈕觸發資料夾選擇
        btnSelectDir.addEventListener('click', () => pmxDirUpload.click());

        pmxDirUpload.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            // 1. 自動從資料夾中尋找 .pmx 檔案
            const pmxFiles = files.filter(f => f.name.toLowerCase().endsWith('.pmx'));
            
            if (pmxFiles.length === 0) {
                showMessage("在選擇的資料夾中找不到 .pmx 模型檔！");
                pmxDirUpload.value = '';
                return;
            }

            // 2. 如果有多個 PMX，預設載入第一個
            pmxFile = pmxFiles[0];
            textureFiles = files; // 保留所有貼圖與資料夾結構
            
            if (pmxFiles.length > 1) {
                pmxStatus.innerText = `找到多個模型，預設載入: ${pmxFile.name}`;
            } else {
                pmxStatus.innerText = `準備載入: ${pmxFile.name}`;
            }

            loadPMXScene();
        });

        btnRemovePmx.addEventListener('click', () => {
            if (state.pmxMesh) {
                scene.remove(state.pmxMesh);
                state.pmxMesh = null;
                btnRemovePmx.classList.add('hidden');
                currentPmxUrls.forEach(URL.revokeObjectURL);
                currentPmxUrls = [];
                pmxStatus.innerText = "";
                pmxDirUpload.value = '';
                showMessage("已移除 MMD 場景", false);
            }
        });
    }

    function loadPMXScene() {
        showMessage("開始編譯 MMD 場景與貼圖...", false);
        getEl('loading-indicator').style.display = 'block';
        pmxStatus.innerText = "⏳ 正在分析貼圖路徑與載入模型...";

        if (state.pmxMesh) {
            scene.remove(state.pmxMesh);
            state.pmxMesh = null;
        }
        currentPmxUrls.forEach(URL.revokeObjectURL);
        currentPmxUrls = [];

        // 建立超強大檔案特徵資料庫
        const fileRecords = [];
        
        textureFiles.forEach(file => {
            const url = URL.createObjectURL(file);
            currentPmxUrls.push(url);
            
            const lowerPath = file.webkitRelativePath.replace(/\\/g, '/').toLowerCase();
            const lowerName = file.name.toLowerCase();
            const extIdx = lowerName.lastIndexOf('.');
            const nameNoExt = extIdx > -1 ? lowerName.substring(0, extIdx) : lowerName;
            
            // 亂碼剝離：只保留英文、數字、空白與底線
            const asciiName = nameNoExt.replace(/[^\x20-\x7E]/g, '').trim();

            fileRecords.push({ url, path: lowerPath, name: lowerName, nameNoExt, asciiName });
        });

        // PMX 本身的紀錄
        const pmxUrl = URL.createObjectURL(pmxFile);
        currentPmxUrls.push(pmxUrl);
        fileRecords.push({
            url: pmxUrl,
            path: pmxFile.name.toLowerCase(),
            name: pmxFile.name.toLowerCase(),
            nameNoExt: pmxFile.name.toLowerCase().split('.')[0],
            asciiName: pmxFile.name.toLowerCase().split('.')[0].replace(/[^\x20-\x7E]/g, '').trim()
        });

        // 攔截並重定向 Three.js 的讀取請求
        const manager = new THREE.LoadingManager();
        manager.addHandler(/\.dds$/i, new DDSLoader(manager));
        manager.addHandler(/\.tga$/i, new TGALoader(manager));
        manager.setURLModifier((url) => {
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;

            let reqPath = url;
            // 嘗試解碼 URI (例如把 %EF%BF%87 解碼回亂碼字元)
            try { reqPath = decodeURIComponent(reqPath); } catch(e) {}
            
            reqPath = reqPath.replace(/\\/g, '/').toLowerCase();
            reqPath = reqPath.replace(/^(\.\.\/|\.\/)+/, ''); // 拔除相對路徑符號

            const reqFileName = reqPath.split('/').pop();
            const extIdx = reqFileName.lastIndexOf('.');
            const reqNameNoExt = extIdx > -1 ? reqFileName.substring(0, extIdx) : reqFileName;
            const reqAscii = reqNameNoExt.replace(/[^\x20-\x7E]/g, '').trim();

            // 策略 1：精確完整路徑比對
            let match = fileRecords.find(f => f.path.endsWith(reqPath));
            if (match) return match.url;

            // 策略 2：忽略資料夾，只比對完整檔名
            match = fileRecords.find(f => f.name === reqFileName);
            if (match) return match.url;

            // 策略 3：忽略副檔名 (例如 PMX 找 .dds 但你只有 .png)
            match = fileRecords.find(f => f.nameNoExt === reqNameNoExt);
            if (match) return match.url;

            // 策略 4：暴力亂碼修復比對 (拔除日文/中文/亂碼後比對英數部分)
            // 🔥 修正：把長度限制改為 > 0，這樣檔名只有 "1" 的也能配對到！
            if (reqAscii.length > 0) { 
                match = fileRecords.find(f => f.asciiName === reqAscii);
                
                // 策略 5：(殺手鐧) 如果完全相等找不到，找「包含」這個英數特徵的檔案
                if (!match) {
                    match = fileRecords.find(f => f.asciiName.includes(reqAscii) || reqAscii.includes(f.asciiName));
                }
                
                if (match) return match.url;
            }

            console.warn(`[PMX 貼圖遺失] 無法配對: ${url} (過濾後特徵: ${reqAscii})`);
            return url;
        });

        const loader = new MMDLoader(manager);
        
        loader.load(pmxFile.name, (mesh) => {
            state.pmxMesh = mesh;
            mesh.scale.set(0.085, 0.085, 0.085); 
            mesh.position.set(0, 0, 0);
            
            // MMD 材質修正
            mesh.traverse((child) => {
                if (child.isMesh && child.material) {
                    child.castShadow = true;
                    child.receiveShadow = true; 
                    
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    
                    mats.forEach(m => { 
                        m.side = THREE.DoubleSide; 
                        m.alphaTest = 0.5; 
                        m.transparent = m.opacity < 1.0; 

                        if (m.emissive) m.emissive.setHex(0x000000); 
                        
                        // ▼▼▼ 新增：為了啟動 SSR 反射，增加材質的鏡面反光係數 ▼▼▼
                        if (m.type === 'MeshPhongMaterial' || m.type === 'MeshToonMaterial') {
                            m.shininess = 80;        // 提高光澤度
                            m.reflectivity = 0.8;    // 開啟反射率
                            if (m.specular) m.specular.setHex(0x333333); // 給予一點點高光
                        }
                        // ▲▲▲ 新增結束 ▲▲▲
                        
                        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
                    });
                }
            });

            scene.add(mesh);
            
            btnRemovePmx.classList.remove('hidden');
            pmxStatus.innerText = "✅ 場景載入成功！";
            getEl('loading-indicator').style.display = 'none';
            showMessage("MMD 場景載入成功！", false);
            
        }, undefined, (err) => {
            console.error("PMX Load Error:", err);
            getEl('loading-indicator').style.display = 'none';
            pmxStatus.innerText = "❌ 載入失敗，請確認資料夾內容";
            showMessage("PMX 載入失敗，可能檔案格式不支援。");
        });
    }

    getEl('vmc-btn').addEventListener('click', toggleVMC);

    const recordBtn = getEl('record-btn');

    if(recordBtn){

        recordBtn.addEventListener('click', () => {
        if (!state.isRecordingMotion) {
            state.motionFrames = []; // 清空舊數據
            state.isRecordingMotion = true;
            state.mode = 'video'; // 強制進入 AI 處理模式
            recordBtn.innerText = "■ 停止動作錄製";
            showMessage("正在錄製動作數據...", false);
        } else {
            state.isRecordingMotion = false;
            recordBtn.innerText = "● 錄製動作";
            saveMotionData(); // 儲存成檔案
        }
    });

    }

    getEl('test-center-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        getEl('test-menu').classList.toggle('show');
    });
    window.addEventListener('click', (e) => {
        const menu = getEl('test-menu');
        if (menu) menu.classList.remove('show');
        if (!e.target.closest('.custom-dropdown-row')) {
            document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.remove('show'));
            document.querySelectorAll('.custom-dropdown-row').forEach(r => r.classList.remove('active-row'));
        }
    });

    const fixStyles = () => {
        const fp = document.getElementById('floating-preview');
        const sv = document.getElementById('source-video');
        if (fp) {
            fp.style.background = 'transparent';
            fp.style.border = 'none';
            fp.style.boxShadow = 'none';
            fp.onmouseenter = () => { fp.style.background = 'rgba(0, 0, 0, 0.6)'; fp.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.5)'; };
            fp.onmouseleave = () => { fp.style.background = 'transparent'; fp.style.boxShadow = 'none'; };
        }
    };
    fixStyles();

    window.changeBg = (color) => {
        state.bgColor = color;
        if (color === 'transparent') {
            scene.background = null; 
            renderer.setClearColor(0x000000, 0); 
            document.body.style.backgroundImage = "url('https://media.istockphoto.com/id/1146311489/vector/transparent-background-pattern-gray-and-white-squares.jpg?s=612x612&w=0&k=20&c=LqKjV84rX2f5e_MhXk7sK4Y5q3z2q1x0oP5j3l6k2g=')"; 
        } else {
            scene.background = new THREE.Color(color);
            renderer.setClearColor(new THREE.Color(color), 1);
            document.body.style.background = color; 
            document.body.style.backgroundImage = "none";
        }
    };

    const sliderIds = ['smooth', 'bloom-strength', 'bloom-thresh', 'bloom-radius', 'bloom'];
    sliderIds.forEach(id => {
        const slider = getEl(`${id}-slider`);
        const valDisp = getEl(`${id}-val`);
        if(slider) {
            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if(id === 'smooth') state.smoothness = val;
                else if(id === 'bloom-strength' || id === 'bloom') bloomPass.strength = val;
                else if(id === 'bloom-thresh') bloomPass.threshold = val;
                else if(id === 'bloom-radius') bloomPass.radius = val;
                if(valDisp) valDisp.innerText = val.toFixed(id === 'bloom-thresh' || id === 'smooth' ? 2 : 1);
            });
        }
    });

    const toggleEyeBtn = getEl('toggle-eye-btn');
    if (toggleEyeBtn) {
        toggleEyeBtn.addEventListener('click', () => {
            state.enableEyeTracking = !state.enableEyeTracking;
            
            if (state.enableEyeTracking) {
                toggleEyeBtn.innerText = "👁️ 眼睛追蹤：開啟";
                toggleEyeBtn.classList.replace('bg-gray-600', 'bg-cyan-600');
            } else {
                toggleEyeBtn.innerText = "✖️ 眼睛追蹤：關閉";
                toggleEyeBtn.classList.replace('bg-cyan-600', 'bg-gray-600');
                showMessage("眼睛追蹤已停用", false);
            }
        });
    }

    // --- 腿部追蹤開關邏輯 ---
    const toggleLegBtn = getEl('toggle-leg-btn');
    if (toggleLegBtn) {
        toggleLegBtn.addEventListener('click', () => {
            state.enableLegTracking = !state.enableLegTracking;
            
            if (state.enableLegTracking) {
                toggleLegBtn.innerText = "🦵 腿部追蹤：開啟";
                toggleLegBtn.classList.replace('bg-gray-600', 'bg-cyan-600');
                showMessage("腿部追蹤已開啟 (全身模式)", false);
            } else {
                toggleLegBtn.innerText = "🦵 腿部追蹤：關閉";
                toggleLegBtn.classList.replace('bg-cyan-600', 'bg-gray-600');
                showMessage("腿部追蹤已停用 (半身鎖定模式)", false);
                
                // 關閉時，立刻將腿部骨骼歸零(立正)，避免卡在奇怪的姿勢
                if (state.vrm) {
                    const legs = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
                    legs.forEach(bone => {
                        const node = state.vrm.humanoid.getNormalizedBoneNode(bone);
                        if (node) adaptiveSlerp(node, new THREE.Quaternion(), 1); // 強制歸零
                    });
                }
            }
        });
    }

    // --- 預覽視窗顯示開關 (不影響 AI 偵測) ---
    const togglePreviewBtn = getEl('toggle-preview-btn');
    const floatingPreview = getEl('floating-preview');

    if (togglePreviewBtn && floatingPreview) {
        togglePreviewBtn.addEventListener('click', () => {
            state.previewVisible = !state.previewVisible;
            
            if (state.previewVisible) {
                // 顯示視窗
                floatingPreview.style.opacity = "1";
                floatingPreview.style.pointerEvents = "auto";
                togglePreviewBtn.innerText = "🖼️ 預覽視窗：顯示中";
                togglePreviewBtn.classList.replace('bg-gray-600', 'bg-blue-600');
            } else {
                // 隱藏視窗 (使用 opacity 0 是為了讓 video 標籤在背景繼續渲染，AI 才能抓到圖)
                floatingPreview.style.opacity = "0";
                floatingPreview.style.pointerEvents = "none";
                togglePreviewBtn.innerText = "👻 預覽視窗：隱藏中";
                togglePreviewBtn.classList.replace('bg-blue-600', 'bg-gray-600');
                showMessage("預覽已隱藏，AI 仍會繼續追蹤", false);
            }
        });
    }

    getEl('settings-btn').addEventListener('click', () => getEl('settings-modal').classList.remove('hidden'));
    getEl('close-settings').addEventListener('click', () => getEl('settings-modal').classList.add('hidden'));
    
    getEl('tab-video').addEventListener('click', () => {
        getEl('section-video').classList.remove('hidden'); getEl('section-webcam').classList.add('hidden');
        getEl('tab-video').className = "py-2 rounded-lg bg-blue-600 text-sm font-bold shadow-lg transition-all";
        getEl('tab-webcam').className = "py-2 rounded-lg text-gray-400 text-sm font-bold hover:bg-gray-700 transition-all";
    });
    getEl('tab-webcam').addEventListener('click', () => {
        getEl('section-webcam').classList.remove('hidden'); getEl('section-video').classList.add('hidden');
        getEl('tab-webcam').className = "py-2 rounded-lg bg-blue-600 text-sm font-bold shadow-lg transition-all";
        getEl('tab-video').className = "py-2 rounded-lg text-gray-400 text-sm font-bold hover:bg-gray-700 transition-all";
    });

    getEl('btn-run-webcam').addEventListener('click', async () => {
        try {
            if (state.videoSource && state.videoSource.srcObject) {
                state.videoSource.srcObject.getTracks().forEach(track => track.stop());
            }
            const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
            const video = getEl('source-video');
            if (video) {
                video.pause(); video.src = ""; video.srcObject = stream;
                state.videoSource = video; state.mode = 'webcam'; await video.play();
                getEl('settings-modal').classList.add('hidden');
                getEl('floating-preview').style.display = 'block';
                getEl('video-controls').classList.add('hidden'); 
                fixStyles();
                showMessage("攝像頭已就緒", false);
            }
        } catch(e) { 
            showMessage("無法啟動攝像頭，請確認權限設定。"); 
        }
    });

    getEl('btn-run-video').addEventListener('click', () => {
        const videoUpload = getEl('video-upload');
        if (videoUpload.files[0]) {
            const video = getEl('source-video');
            if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
            video.src = URL.createObjectURL(videoUpload.files[0]);
            state.videoSource = video; state.mode = 'video'; 
            video.play();
            getEl('settings-modal').classList.add('hidden');
            getEl('floating-preview').style.display = 'block';
            const controls = getEl('video-controls');
            controls.classList.remove('hidden');
            setupVideoControls(video);
            fixStyles();
        }
    });

    const clearTests = () => {
        state.testAttention = state.testZombie = state.testForward = state.testBackward = state.testHandsOnHips = state.testArmLoop = state.testLeftHand = state.testLegCurl = false;
        document.querySelectorAll('.test-menu-item').forEach(i => i.classList.remove('active'));
    };

    getEl('test-loop-btn').onclick = (e) => { const active = state.testArmLoop; clearTests(); state.testArmLoop = !active; if(state.testArmLoop) e.target.classList.add('active'); };
    getEl('test-attention-btn').onclick = (e) => { const active = state.testAttention; clearTests(); state.testAttention = !active; if(state.testAttention) e.target.classList.add('active'); };
    getEl('test-zombie-btn').onclick = (e) => { const active = state.testZombie; clearTests(); state.testZombie = !active; if(state.testZombie) e.target.classList.add('active'); };
    getEl('test-forward-btn').onclick = (e) => { const active = state.testForward; clearTests(); state.testForward = !active; if(state.testForward) e.target.classList.add('active'); };
    getEl('test-backward-btn').onclick = (e) => { const active = state.testBackward; clearTests(); state.testBackward = !active; if(state.testBackward) e.target.classList.add('active'); };
    getEl('test-hips-btn').onclick = (e) => { const active = state.testHandsOnHips; clearTests(); state.testHandsOnHips = !active; if(state.testHandsOnHips) e.target.classList.add('active'); };
    getEl('test-leg-curl-btn').onclick = (e) => { const active = state.testLegCurl; clearTests(); state.testLegCurl = !active; if(state.testLegCurl) e.target.classList.add('active'); };
    getEl('test-hand-btn').onclick = (e) => { state.testLeftHand = !state.testLeftHand; if(state.testLeftHand) e.target.classList.add('active'); };

    getEl('reset-pose-btn').onclick = () => {
        clearTests();
        if(state.vrm) state.vrm.humanoid.resetNormalizedPose();
        showMessage("姿勢已重置", false);
    };

    ['x', 'y', 'z'].forEach(axis => {
        const armEl = getEl(`mirror-arm-${axis}`);
        const legEl = getEl(`mirror-leg-${axis}`);
        if(armEl) armEl.addEventListener('change', (e) => state.mirror.arms[axis] = e.target.checked ? -1 : 1);
        if(legEl) legEl.addEventListener('change', (e) => state.mirror.legs[axis] = e.target.checked ? -1 : 1);
    });

    const mappingContainer = getEl('mapping-container');
    if (mappingContainer) {
        Object.keys(KALIDOKIT_MAP).forEach(aiPoint => {
            const row = document.createElement('div');
            row.className = "custom-dropdown-row flex items-center gap-3 bg-gray-800/50 p-2 rounded-xl border border-gray-700/50 shadow-sm";
            const labelDiv = document.createElement('div');
            labelDiv.className = "text-[10px] font-black text-gray-400 w-24 truncate pl-2";
            labelDiv.innerText = aiPoint;
            const ddContainer = document.createElement('div');
            ddContainer.className = "flex-1 relative";
            const btn = document.createElement('div');
            btn.className = "custom-dropdown-btn";
            btn.innerHTML = `<span>${state.mapping[aiPoint]}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>`;
            const menu = document.createElement('div');
            menu.className = "custom-dropdown-menu";
            const searchContainer = document.createElement('div');
            searchContainer.className = "dropdown-search-container";
            const input = document.createElement('input');
            input.type = "text";
            input.className = "dropdown-search-input";
            input.placeholder = "搜尋骨骼...";
            searchContainer.appendChild(input);
            menu.appendChild(searchContainer);
            const optionsScroll = document.createElement('div');
            optionsScroll.className = "dropdown-options-scroll";
            menu.appendChild(optionsScroll);
            VRM_BONE_LIST.forEach(bone => {
                const formatName = 'J_' + bone.charAt(0).toUpperCase() + bone.slice(1);
                const item = document.createElement('div');
                item.className = "dropdown-item";
                item.innerText = formatName;
                if (state.mapping[aiPoint] === formatName) item.classList.add('selected');
                item.onclick = (e) => {
                    e.stopPropagation();
                    state.mapping[aiPoint] = formatName;
                    btn.querySelector('span').innerText = formatName;
                    optionsScroll.querySelectorAll('.dropdown-item').forEach(d => d.classList.remove('selected'));
                    item.classList.add('selected');
                    menu.classList.remove('show');
                    row.classList.remove('active-row');
                };
                optionsScroll.appendChild(item);
            });
            input.oninput = (e) => {
                const term = e.target.value.toLowerCase();
                optionsScroll.querySelectorAll('.dropdown-item').forEach(item => {
                    const text = item.innerText.toLowerCase();
                    if (text.includes(term)) item.classList.remove('hidden-item');
                    else item.classList.add('hidden-item');
                });
            };
            input.onclick = (e) => e.stopPropagation();
            btn.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.remove('show'));
                document.querySelectorAll('.custom-dropdown-row').forEach(r => r.classList.remove('active-row'));
                menu.classList.toggle('show');
                if (menu.classList.contains('show')) {
                    row.classList.add('active-row');
                    input.value = "";
                    input.focus(); 
                    optionsScroll.querySelectorAll('.dropdown-item').forEach(item => item.classList.remove('hidden-item'));
                }
            };
            ddContainer.appendChild(btn);
            ddContainer.appendChild(menu);
            row.appendChild(labelDiv);
            row.appendChild(ddContainer);
            mappingContainer.appendChild(row);
        });
    }
};

const _worldForward = new THREE.Vector3(0, 1, 0);
function captureCalibrationPose(lm3D) {
    if (!lm3D) return;

    const bones = [
        ['leftUpperArm', 11, 13],
        ['leftLowerArm', 13, 15],
        ['rightUpperArm', 12, 14],
        ['rightLowerArm', 14, 16],
        //['leftUpperLeg', 23, 25],
        //['leftLowerLeg', 25, 27],
        //['rightUpperLeg', 24, 26],
        //['rightLowerLeg', 26, 28],
    ];

    state.calibration.poseDirs = {};

    bones.forEach(([key, a, b]) => {
        if (!lm3D[a] || !lm3D[b]) return;

        convert(lm3D[a], _v1);
        convert(lm3D[b], _v2);

        const dir = new THREE.Vector3()
            .subVectors(_v2, _v1)
            .normalize();

        // ✅ 存「從世界 forward → 校準方向」的 quaternion
        const q = new THREE.Quaternion()
            .setFromUnitVectors(_worldForward, dir);

        state.calibration.poseDirs[key] = q.clone();
    });

    state.calibration.active = true;
    showMessage("📐 校準完成（已修正折疊問題）", false);
}



function setupVideoControls(video) {
    const playBtn = getEl('btn-play-pause');
    const iconPause = getEl('icon-pause');
    const iconPlay = getEl('icon-play');
    const seeker = getEl('video-seeker');
    const timeDisplay = getEl('video-time');
    playBtn.onclick = () => {
        if (video.paused) { video.play(); iconPause.classList.remove('hidden'); iconPlay.classList.add('hidden'); }
        else { video.pause(); iconPause.classList.add('hidden'); iconPlay.classList.remove('hidden'); }
    };
    video.ontimeupdate = () => {
        const val = (100 / video.duration) * video.currentTime;
        seeker.value = val;
        timeDisplay.innerText = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    };
    seeker.oninput = () => { const time = video.duration * (seeker.value / 100); video.currentTime = time; };
    const formatTime = (seconds) => {
        if(isNaN(seconds)) return "00:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m < 10 ? '0'+m : m}:${s < 10 ? '0'+s : s}`;
    }
}

animate();
setupEventListeners();
loadVRM('https://raw.githubusercontent.com/pixiv/three-vrm/master/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm');

const dOverlay = getEl('drag-overlay');
window.ondragover = (e) => { e.preventDefault(); if(dOverlay) dOverlay.classList.add('active'); };
window.ondragleave = () => { if(dOverlay) dOverlay.classList.remove('active'); };
window.ondrop = (e) => {
    e.preventDefault();
    if(dOverlay) dOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.vrm')) loadVRM(URL.createObjectURL(file));
};

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'c') {

        if (!state.lastPoseLandmarks) {
            showMessage("❌ 尚未取得姿勢資料", true);
            return;
        }

        let countdown = 5;
        showMessage(`📐 ${countdown} 秒後進行校準，請站直不動`, false);

        const timer = setInterval(() => {
            countdown--;

            if (countdown > 0) {
                showMessage(`📐 ${countdown} 秒後進行校準，請站直不動`, false);
            } else {
                clearInterval(timer);
                captureCalibrationPose(state.lastPoseLandmarks);
            }
        }, 1000);
    }
});


const FACEMESH_TESSELATION = [
    [127, 34],  [34, 139],  [139, 127], [11, 0],    [0, 37],    [37, 11],
    [232, 231], [231, 120], [120, 232], [72, 37],   [37, 39],   [39, 72],
    [128, 121], [121, 47],  [47, 128],  [232, 121], [121, 128], [128, 232],
    [104, 69],  [69, 67],   [67, 104],  [175, 171], [171, 148], [148, 175],
    [118, 50],  [50, 101],  [101, 118], [73, 39],   [39, 40],   [40, 73],
    [9, 151],   [151, 108], [108, 9],   [48, 115],  [115, 131], [131, 48],
    [194, 204], [204, 211], [211, 194], [74, 40],   [40, 185],  [185, 74],
    [80, 42],   [42, 183],  [183, 80],  [40, 92],   [92, 186],  [186, 40],
    [230, 229], [229, 118], [118, 230], [202, 212], [212, 214], [214, 202],
    [83, 18],   [18, 17],   [17, 83],   [76, 61],   [61, 146],  [146, 76],
    [160, 29],  [29, 30],   [30, 160],  [56, 157],  [157, 173], [173, 56],
    [106, 204], [204, 194], [194, 106], [135, 214], [214, 192], [192, 135],
    [203, 165], [165, 98],  [98, 203],  [21, 71],   [71, 68],   [68, 21],
    [51, 45],   [45, 4],    [4, 51],    [144, 24],  [24, 23],   [23, 144],
    [77, 146],  [146, 91],  [91, 77],   [205, 50],  [50, 187],  [187, 205],
    [201, 200], [200, 18],  [18, 201],  [91, 106],  [106, 182], [182, 91],
    [90, 91],   [91, 181],  [181, 90],  [85, 84],   [84, 17],   [17, 85],
    [206, 203], [203, 36],  [36, 206],  [148, 171], [171, 140], [140, 148],
    [92, 40],   [40, 39],   [39, 92],   [193, 189], [189, 244], [244, 193],
    [159, 158], [158, 28],  [28, 159],  [247, 246], [246, 161], [161, 247],
    [236, 3],   [3, 196],   [196, 236], [54, 68],   [68, 104],  [104, 54],
    [193, 168], [168, 8],   [8, 193],   [117, 228], [228, 31],  [31, 117],
    [189, 193], [193, 55],  [55, 189],  [98, 97],   [97, 99],   [99, 98],
    [126, 47],  [47, 100],  [100, 126], [166, 79],  [79, 218],  [218, 166],
    [155, 154], [154, 26],  [26, 155],  [209, 49],  [49, 131],  [131, 209],
    [135, 136], [136, 150], [150, 135], [47, 126],  [126, 217], [217, 47],
    [223, 52],  [52, 53],   [53, 223],  [45, 51],   [51, 134],  [134, 45],
    [211, 170], [170, 140], [140, 211], [67, 69],   [69, 108],  [108, 67],
    [43, 106],  [106, 91],  [91, 43],   [230, 119], [119, 120], [120, 230],
    [226, 130], [130, 247], [247, 226], [63, 53],   [53, 52],   [52, 63],
    [238, 20],  [20, 242],  [242, 238], [46, 70],   [70, 156],  [156, 46],
    [78, 62],   [62, 96],   [96, 78],   [46, 53],   [53, 63],   [63, 46],
    [143, 34],  [34, 227],  [227, 143], [123, 117], [117, 111], [111, 123],
    [44, 125],  [125, 19],  [19, 44],   [236, 134], [134, 51],  [51, 236],
    [216, 206], [206, 205], [205, 216], [154, 153], [153, 22],  [22, 154],
    [39, 37],   [37, 167],  [167, 39],  [200, 201], [201, 208], [208, 200],
    [36, 142],  [142, 100], [100, 36],  [57, 212],  [212, 202], [202, 57],
    [20, 60],   [60, 99],   [99, 20],   [28, 158],  [158, 157], [157, 28],
    [35, 226],  [226, 113], [113, 35],  [160, 159], [159, 27],  [27, 160],
    [204, 202], [202, 210], [210, 204], [113, 225], [225, 46],  [46, 113],
    [43, 202],  [202, 204], [204, 43],  [62, 76],   [76, 77],   [77, 62],
    [137, 123], [123, 116], [116, 137], [41, 38],   [38, 72],   [72, 41],
    [203, 129], [129, 142], [142, 203], [64, 98],   [98, 240],  [240, 64],
    [49, 102],  [102, 64],  [64, 49],   [41, 73],   [73, 74],   [74, 41],
    [212, 216], [216, 207], [207, 212], [42, 74],   [74, 184],  [184, 42],
    [169, 170], [170, 211], [211, 169], [170, 149], [149, 176], [176, 170],
    [105, 66],  [66, 69],   [69, 105],  [122, 6],   [6, 168],   [168, 122],
    [123, 147], [147, 187], [187, 123], [96, 77],   [77, 90],   [90, 96],
    [65, 55],   [55, 107],  [107, 65],  [89, 90],   [90, 180],  [180, 89],
    [101, 100], [100, 120], [120, 101], [63, 105],  [105, 104], [104, 63],
    [93, 137],  [137, 227], [227, 93],  [15, 86],   [86, 85],   [85, 15],
    [129, 102], [102, 49],  [49, 129],  [14, 87],   [87, 86],   [86, 14],
    [55, 8],    [8, 9],     [9, 55],    [100, 47],  [47, 121],  [121, 100],
    [145, 23],  [23, 22],   [22, 145],  [88, 89],   [89, 179],  [179, 88],
    [6, 122],   [122, 196], [196, 6],   [88, 95],   [95, 96],   [96, 88],
    [138, 172], [172, 136], [136, 138], [215, 58],  [58, 172],  [172, 215],
    [115, 48],  [48, 219],  [219, 115], [42, 80],   [80, 81],   [81, 42],
    [195, 3],   [3, 51],    [51, 195],  [43, 146],  [146, 61],  [61, 43],
    [171, 175], [175, 199], [199, 171], [81, 82],   [82, 38],   [38, 81],
    [53, 46],   [46, 225],  [225, 53],  [144, 163], [163, 110], [110, 144],
    [52, 65],   [65, 66],   [66, 52],   [229, 228], [228, 117], [117, 229],
    [34, 127],  [127, 234], [234, 34],  [107, 108], [108, 69],  [69, 107],
    [109, 108], [108, 151], [151, 109], [48, 64],   [64, 235],  [235, 48],
    [62, 78],   [78, 191],  [191, 62],  [129, 209], [209, 126], [126, 129],
    [111, 35],  [35, 143],  [143, 111], [117, 123], [123, 50],  [50, 117],
    [222, 65],  [65, 52],   [52, 222],  [19, 125],  [125, 141], [141, 19],
    [221, 55],  [55, 65],   [65, 221],  [3, 195],   [195, 197], [197, 3],
    [25, 7],    [7, 33],    [33, 25],   [220, 237], [237, 44],  [44, 220],
    [70, 71],   [71, 139],  [139, 70],  [122, 193], [193, 245], [245, 122],
    [247, 130], [130, 33],  [33, 247],  [71, 21],   [21, 162],  [162, 71],
    [170, 169], [169, 150], [150, 170], [188, 174], [174, 196], [196, 188],
    [216, 186], [186, 92],  [92, 216],  [2, 97],    [97, 167],  [167, 2],
    [141, 125], [125, 241], [241, 141], [164, 167], [167, 37],  [37, 164],
    [72, 38],   [38, 12],   [12, 72],   [38, 82],   [82, 13],   [13, 38],
    [63, 68],   [68, 71],   [71, 63],   [226, 35],  [35, 111],  [111, 226],
    [101, 50],  [50, 205],  [205, 101], [206, 92],  [92, 165],  [165, 206],
    [209, 198], [198, 217], [217, 209], [165, 167], [167, 97],  [97, 165],
    [220, 115], [115, 218], [218, 220], [133, 112], [112, 243], [243, 133],
    [239, 238], [238, 241], [241, 239], [214, 135], [135, 169], [169, 214],
    [190, 173], [173, 133], [133, 190], [171, 208], [208, 32],  [32, 171],
    [125, 44],  [44, 237],  [237, 125], [86, 87],   [87, 178],  [178, 86],
    [85, 86],   [86, 179],  [179, 85],  [84, 85],   [85, 180],  [180, 84],
    [83, 84],   [84, 181],  [181, 83],  [201, 83],  [83, 182],  [182, 201],
    [137, 93],  [93, 132],  [132, 137], [76, 62],   [62, 183],  [183, 76],
    [61, 76],   [76, 184],  [184, 61],  [57, 61],   [61, 185],  [185, 57],
    [212, 57],  [57, 186],  [186, 212], [214, 207], [207, 187], [187, 214],
    [34, 143],  [143, 156], [156, 34],  [79, 239],  [239, 237], [237, 79],
    [123, 137], [137, 177], [177, 123], [44, 1],    [1, 4],     [4, 44],
    [201, 194], [194, 32],  [32, 201],  [64, 102],  [102, 129], [129, 64],
    [213, 215], [215, 138], [138, 213], [59, 166],  [166, 219], [219, 59],
    [242, 99],  [99, 97],   [97, 242],  [2, 94],    [94, 141],  [141, 2],
    [75, 59],   [59, 235],  [235, 75],  [24, 110],  [110, 228], [228, 24],
    [25, 130],  [130, 226], [226, 25],  [23, 24],   [24, 229],  [229, 23],
    [22, 23],   [23, 230],  [230, 22],  [26, 22],   [22, 231],  [231, 26],
    [112, 26],  [26, 232],  [232, 112], [189, 190], [190, 243], [243, 189],
    [221, 56],  [56, 190],  [190, 221], [28, 56],   [56, 221],  [221, 28],
    [27, 28],   [28, 222],  [222, 27],  [29, 27],   [27, 223],  [223, 29],
    [30, 29],   [29, 224],  [224, 30],  [247, 30],  [30, 225],  [225, 247],
    [238, 79],  [79, 20],   [20, 238],  [166, 59],  [59, 75],   [75, 166],
    [60, 75],   [75, 240],  [240, 60],  [147, 177], [177, 215], [215, 147],
    [20, 79],   [79, 166],  [166, 20],  [187, 147], [147, 213], [213, 187],
    [112, 233], [233, 244], [244, 112], [233, 128], [128, 245], [245, 233],
    [128, 114], [114, 188], [188, 128], [114, 217], [217, 174], [174, 114],
    [131, 115], [115, 220], [220, 131], [217, 198], [198, 236], [236, 217],
    [198, 131], [131, 134], [134, 198], [177, 132], [132, 58],  [58, 177],
    [143, 35],  [35, 124],  [124, 143], [110, 163], [163, 7],   [7, 110],
    [228, 110], [110, 25],  [25, 228],  [356, 389], [389, 368], [368, 356],
    [11, 302],  [302, 267], [267, 11],  [452, 350], [350, 349], [349, 452],
    [302, 303], [303, 269], [269, 302], [357, 343], [343, 277], [277, 357],
    [452, 453], [453, 357], [357, 452], [333, 332], [332, 297], [297, 333],
    [175, 152], [152, 377], [377, 175], [347, 348], [348, 330], [330, 347],
    [303, 304], [304, 270], [270, 303], [9, 336],   [336, 337], [337, 9],
    [278, 279], [279, 360], [360, 278], [418, 262], [262, 431], [431, 418],
    [304, 408], [408, 409], [409, 304], [310, 415], [415, 407], [407, 310],
    [270, 409], [409, 410], [410, 270], [450, 348], [348, 347], [347, 450],
    [422, 430], [430, 434], [434, 422], [313, 314], [314, 17],  [17, 313],
    [306, 307], [307, 375], [375, 306], [387, 388], [388, 260], [260, 387],
    [286, 414], [414, 398], [398, 286], [335, 406], [406, 418], [418, 335],
    [364, 367], [367, 416], [416, 364], [423, 358], [358, 327], [327, 423],
    [251, 284], [284, 298], [298, 251], [281, 5],   [5, 4],     [4, 281],
    [373, 374], [374, 253], [253, 373], [307, 320], [320, 321], [321, 307],
    [425, 427], [427, 411], [411, 425], [421, 313], [313, 18],  [18, 421],
    [321, 405], [405, 406], [406, 321], [320, 404], [404, 405], [405, 320],
    [315, 16],  [16, 17],   [17, 315],  [426, 425], [425, 266], [266, 426],
    [377, 400], [400, 369], [369, 377], [322, 391], [391, 269], [269, 322],
    [417, 465], [465, 464], [464, 417], [386, 257], [257, 258], [258, 386],
    [466, 260], [260, 388], [388, 466], [456, 399], [399, 419], [419, 456],
    [284, 332], [332, 333], [333, 284], [417, 285], [285, 8],   [8, 417],
    [346, 340], [340, 261], [261, 346], [413, 441], [441, 285], [285, 413],
    [327, 460], [460, 328], [328, 327], [355, 371], [371, 329], [329, 355],
    [392, 439], [439, 438], [438, 392], [382, 341], [341, 256], [256, 382],
    [429, 420], [420, 360], [360, 429], [364, 394], [394, 379], [379, 364],
    [277, 343], [343, 437], [437, 277], [443, 444], [444, 283], [283, 443],
    [275, 440], [440, 363], [363, 275], [431, 262], [262, 369], [369, 431],
    [297, 338], [338, 337], [337, 297], [273, 375], [375, 321], [321, 273],
    [450, 451], [451, 349], [349, 450], [446, 342], [342, 467], [467, 446],
    [293, 334], [334, 282], [282, 293], [458, 461], [461, 462], [462, 458],
    [276, 353], [353, 383], [383, 276], [308, 324], [324, 325], [325, 308],
    [276, 300], [300, 293], [293, 276], [372, 345], [345, 447], [447, 372],
    [352, 345], [345, 340], [340, 352], [274, 1],   [1, 19],    [19, 274],
    [456, 248], [248, 281], [281, 456], [436, 427], [427, 425], [425, 436],
    [381, 256], [256, 252], [252, 381], [269, 391], [391, 393], [393, 269],
    [200, 199], [199, 428], [428, 200], [266, 330], [330, 329], [329, 266],
    [287, 273], [273, 422], [422, 287], [250, 462], [462, 328], [328, 250],
    [258, 286], [286, 384], [384, 258], [265, 353], [353, 342], [342, 265],
    [387, 259], [259, 257], [257, 387], [424, 431], [431, 430], [430, 424],
    [342, 353], [353, 276], [276, 342], [273, 335], [335, 424], [424, 273],
    [292, 325], [325, 307], [307, 292], [366, 447], [447, 345], [345, 366],
    [271, 303], [303, 302], [302, 271], [423, 266], [266, 371], [371, 423],
    [294, 455], [455, 460], [460, 294], [279, 278], [278, 294], [294, 279],
    [271, 272], [272, 304], [304, 271], [432, 434], [434, 427], [427, 432],
    [272, 407], [407, 408], [408, 272], [394, 430], [430, 431], [431, 394],
    [395, 369], [369, 400], [400, 395], [334, 333], [333, 299], [299, 334],
    [351, 417], [417, 168], [168, 351], [352, 280], [280, 411], [411, 352],
    [325, 319], [319, 320], [320, 325], [295, 296], [296, 336], [336, 295],
    [319, 403], [403, 404], [404, 319], [330, 348], [348, 349], [349, 330],
    [293, 298], [298, 333], [333, 293], [323, 454], [454, 447], [447, 323],
    [15, 16],   [16, 315],  [315, 15],  [358, 429], [429, 279], [279, 358],
    [14, 15],   [15, 316],  [316, 14],  [285, 336], [336, 9],   [9, 285],
    [329, 349], [349, 350], [350, 329], [374, 380], [380, 252], [252, 374],
    [318, 402], [402, 403], [403, 318], [6, 197],   [197, 419], [419, 6],
    [318, 319], [319, 325], [325, 318], [367, 364], [364, 365], [365, 367],
    [435, 367], [367, 397], [397, 435], [344, 438], [438, 439], [439, 344],
    [272, 271], [271, 311], [311, 272], [195, 5],   [5, 281],   [281, 195],
    [273, 287], [287, 291], [291, 273], [396, 428], [428, 199], [199, 396],
    [311, 271], [271, 268], [268, 311], [283, 444], [444, 445], [445, 283],
    [373, 254], [254, 339], [339, 373], [282, 334], [334, 296], [296, 282],
    [449, 347], [347, 346], [346, 449], [264, 447], [447, 454], [454, 264],
    [336, 296], [296, 299], [299, 336], [338, 10],  [10, 151],  [151, 338],
    [278, 439], [439, 455], [455, 278], [292, 407], [407, 415], [415, 292],
    [358, 371], [371, 355], [355, 358], [340, 345], [345, 372], [372, 340],
    [346, 347], [347, 280], [280, 346], [442, 443], [443, 282], [282, 442],
    [19, 94],   [94, 370],  [370, 19],  [441, 442], [442, 295], [295, 441],
    [248, 419], [419, 197], [197, 248], [263, 255], [255, 359], [359, 263],
    [440, 275], [275, 274], [274, 440], [300, 383], [383, 368], [368, 300],
    [351, 412], [412, 465], [465, 351], [263, 467], [467, 466], [466, 263],
    [301, 368], [368, 389], [389, 301], [395, 378], [378, 379], [379, 395],
    [412, 351], [351, 419], [419, 412], [436, 426], [426, 322], [322, 436],
    [2, 326],   [326, 370], [370, 2],   [305, 460], [460, 455], [455, 305],
    [254, 449], [449, 448], [448, 254], [255, 261], [261, 446], [446, 255],
    [253, 450], [450, 449], [449, 253], [253, 252], [252, 450], [450, 253],
    [252, 256], [256, 451], [451, 252], [256, 341], [341, 452], [452, 256],
    [414, 413], [413, 463], [463, 414], [286, 441], [441, 414], [414, 286],
    [286, 258], [258, 441], [441, 286], [258, 257], [257, 442], [442, 258],
    [257, 259], [259, 443], [443, 257], [259, 260], [260, 444], [444, 259],
    [260, 467], [467, 445], [445, 260], [309, 459], [459, 250], [250, 309],
    [305, 289], [289, 290], [290, 305], [305, 290], [290, 460], [460, 305],
    [401, 376], [376, 435], [435, 401], [309, 250], [250, 392], [392, 309],
    [376, 411], [411, 433], [433, 376], [453, 341], [341, 464], [464, 453],
    [357, 453], [453, 465], [465, 357], [343, 357], [357, 412], [412, 343],
    [437, 343], [343, 399], [399, 437], [344, 360], [360, 440], [440, 344],
    [420, 437], [437, 456], [456, 420], [360, 420], [420, 363], [363, 360],
    [361, 401], [401, 288], [288, 361], [265, 372], [372, 353], [353, 265],
    [390, 339], [339, 249], [249, 390], [339, 448], [448, 255], [255, 339]];

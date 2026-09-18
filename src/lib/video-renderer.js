import {paintBeachBall} from './beach-ball.js';
import {advanceBeachBall, displayBeachBall} from '../../shared/beach-ball.js';
import {crtFlameShader} from './crt-flames.js';
import {createMarshmallowVisits, marshmallowPose, marshmallowShader} from './crt-marshmallow.js';

// Pixel-space distances and the flame hash need more precision than 16-bit
// mediump provides on some GPU backends. Match varying precision in both stages.
const shaderPrecision = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
`;

const vertexSource = `
    ${shaderPrecision}
    attribute vec2 a_position;
    uniform mat4 u_projection;
    uniform vec4 u_rect;
    uniform float u_rotation;
    varying vec2 v_uv;
    void main() {
        float c = cos(u_rotation);
        float s = sin(u_rotation);
        vec2 point = mat2(c, s, -s, c) * ((a_position - 0.5) * u_rect.zw);
        gl_Position = u_projection * vec4(u_rect.xy + u_rect.zw * 0.5 + point, 0.0, 1.0);
        v_uv = a_position;
    }
`;

const fragmentSource = `
    ${shaderPrecision}
    uniform sampler2D u_texture;
    uniform float u_opacity;
    uniform float u_effect;
    varying vec2 v_uv;
    ${crtFlameShader}
    ${marshmallowShader}
    void main() {
        if (u_effect > 1.5) {
            gl_FragColor = crtMarshmallow(v_uv);
            return;
        }
        if (u_effect > 0.5) {
            gl_FragColor = crtFlame(v_uv);
            return;
        }
        vec4 color = texture2D(u_texture, v_uv);
        gl_FragColor = vec4(color.rgb, color.a * u_opacity);
    }
`;

export function orthographicProjection(width, height) {
    return new Float32Array([
        2 / width, 0, 0, 0,
        0, -2 / height, 0, 0,
        0, 0, -1, 0,
        -1, 1, 0, 1,
    ]);
}

export function videoRect(width, height, videoWidth, videoHeight) {
    if (![width, height, videoWidth, videoHeight].every(value => Number.isFinite(value) && value > 0)) return null;
    const scale = Math.min(width / videoWidth, height / videoHeight);
    const scaledWidth = videoWidth * scale;
    const scaledHeight = videoHeight * scale;
    return [(width - scaledWidth) / 2, (height - scaledHeight) / 2, scaledWidth, scaledHeight];
}

export function createVideoRenderer(canvas, video, onActive, overlayCanvas) {
    let gl;
    try {
        gl = canvas.getContext('webgl', {alpha: true, antialias: false, depth: false, stencil: false});
    } catch { /* Native video remains available if WebGL is blocked. */ }
    let overlay;
    try {
        overlay = overlayCanvas?.getContext('2d');
    } catch { /* The optional overlay must not interrupt native playback. */ }

    let program;
    let buffer;
    let emptyTexture;
    let ghostTexture;
    let ballTexture;
    let projectionLocation;
    let rectLocation;
    let opacityLocation;
    let rotationLocation;
    let effectLocation;
    let flameSizeLocation;
    let flameTimeLocation;
    let marshmallowLocation;
    let toastingLocation;
    let stickLocation;
    let breathPathLocation;
    let maxSize = 4096;
    let maxTextureSize;
    let animationId = null;
    let lastBallTime = null;
    let lastFlameTime = null;
    let flameTime = 9.4;
    let crtActive = false;
    const marshmallows = createMarshmallowVisits();
    let active = false;
    let failed = false;
    let lost = false;
    let destroyed = false;
    let ghost = null;
    let ghostDirty = false;
    let ball = null;
    let ballBottomInset = 0;
    let ballSprite = null;
    let overlayDirty = true;
    let hasViewport = false;
    // Video stays on the browser's native compositor. Only effects are drawn
    // here, so a delayed animation callback cannot hold back video playback.
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reducedMotion = !!motionQuery?.matches;

    function setActive(value) {
        if (active === value) return;
        active = value;
        onActive(value);
    }

    function cancelFrame() {
        if (animationId !== null) cancelAnimationFrame(animationId);
        animationId = null;
        lastBallTime = null;
        lastFlameTime = null;
    }

    function disposeResources() {
        if (gl && !lost) {
            for (const resource of [emptyTexture, ghostTexture, ballTexture]) if (resource) gl.deleteTexture(resource);
            if (buffer) gl.deleteBuffer(buffer);
            if (program) gl.deleteProgram(program);
        }
        emptyTexture = ghostTexture = ballTexture = buffer = program = null;
        ghostDirty = !!ghost;
    }

    function releaseBall() {
        if (ballTexture && gl && !lost) gl.deleteTexture(ballTexture);
        ballTexture = null;
        if (ballSprite) ballSprite.width = ballSprite.height = 0;
        ballSprite = null;
        ball = null;
    }

    function fail() {
        failed = true;
        cancelFrame();
        setActive(false);
        disposeResources();
    }

    function createTexture() {
        const resource = gl.createTexture();
        if (!resource) throw new Error('Texture allocation failed.');
        gl.bindTexture(gl.TEXTURE_2D, resource);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return resource;
    }

    function initialize() {
        const shaders = [];
        try {
            failed = false;
            program = gl.createProgram();
            for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
                const shader = gl.createShader(type);
                shaders.push(shader);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Video shader compilation failed.');
                gl.attachShader(program, shader);
            }
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Video shader linking failed.');
            gl.useProgram(program);
            buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
            const positionLocation = gl.getAttribLocation(program, 'a_position');
            gl.enableVertexAttribArray(positionLocation);
            gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
            projectionLocation = gl.getUniformLocation(program, 'u_projection');
            rectLocation = gl.getUniformLocation(program, 'u_rect');
            opacityLocation = gl.getUniformLocation(program, 'u_opacity');
            rotationLocation = gl.getUniformLocation(program, 'u_rotation');
            effectLocation = gl.getUniformLocation(program, 'u_effect');
            flameSizeLocation = gl.getUniformLocation(program, 'u_flameSize');
            flameTimeLocation = gl.getUniformLocation(program, 'u_flameTime');
            marshmallowLocation = gl.getUniformLocation(program, 'u_marshmallow');
            toastingLocation = gl.getUniformLocation(program, 'u_toasting');
            stickLocation = gl.getUniformLocation(program, 'u_stick');
            breathPathLocation = gl.getUniformLocation(program, 'u_breathPath');
            gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
            gl.activeTexture(gl.TEXTURE0);
            emptyTexture = createTexture();
            // Procedural CRT effects still need a complete sampler.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.clearColor(0, 0, 0, 0);
            maxSize = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
            maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        } catch {
            fail();
        } finally {
            for (const shader of shaders) if (shader) gl.deleteShader(shader);
        }
    }

    function resizeCanvas(target, width, height, limit = 4096) {
        const ratio = Math.min(window.devicePixelRatio || 1, 2, limit / width, limit / height);
        const pixelWidth = Math.max(1, Math.round(width * ratio));
        const pixelHeight = Math.max(1, Math.round(height * ratio));
        if (target.width !== pixelWidth || target.height !== pixelHeight) {
            target.width = pixelWidth;
            target.height = pixelHeight;
        }
    }

    function getGhostRect(width, height) {
        if (!ghost?.width || !ghost?.height) return null;
        return videoRect(width, height, video?.videoWidth, video?.videoHeight)
            || videoRect(width, height, ghost.width, ghost.height);
    }

    function getBallSprite() {
        if (!ballSprite) {
            ballSprite = document.createElement('canvas');
            ballSprite.width = ballSprite.height = 256;
            const context = ballSprite.getContext('2d');
            if (context) paintBeachBall(context, ballSprite.width);
        }
        return ballSprite;
    }

    function drawTexture(resource, rect, opacity = 1, rotation = 0) {
        gl.bindTexture(gl.TEXTURE_2D, resource);
        gl.uniform4fv(rectLocation, rect);
        gl.uniform1f(opacityLocation, opacity);
        gl.uniform1f(rotationLocation, rotation);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawGhost(rect) {
        if (!rect) return;
        try {
            if (ghostDirty) {
                ghostDirty = false;
                if (ghost.width > maxTextureSize || ghost.height > maxTextureSize) {
                    if (ghostTexture) gl.deleteTexture(ghostTexture);
                    ghostTexture = null;
                    return;
                }
                if (!ghostTexture) ghostTexture = createTexture();
                gl.bindTexture(gl.TEXTURE_2D, ghostTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ghost);
            }
            if (ghostTexture) drawTexture(ghostTexture, rect, 0.45);
        } catch { /* A released parent-owned image must not disable the video renderer. */
            if (ghostTexture) gl.deleteTexture(ghostTexture);
            ghostTexture = null;
        }
    }

    function clearOverlay() {
        if (!overlay || !overlayDirty) return;
        overlay.setTransform(1, 0, 0, 1, 0, 0);
        overlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        overlayDirty = false;
    }

    function renderOverlay(width, height) {
        clearOverlay();
        if (!overlay || (!ghost && !ball)) return;
        resizeCanvas(overlayCanvas, width, height);
        overlay.save();
        overlay.setTransform(overlayCanvas.width / width, 0, 0, overlayCanvas.height / height, 0, 0);
        const rect = getGhostRect(width, height);
        if (rect) {
            overlay.globalAlpha = 0.45;
            try {
                overlay.drawImage(ghost, ...rect);
            } catch { /* The parent can release its preview image at any time. */ }
        }
        if (ball) {
            const visible = displayBeachBall(ball, width, height, ballBottomInset);
            overlay.globalAlpha = 0.96;
            overlay.translate(visible.x, visible.y);
            overlay.rotate(visible.angle);
            overlay.drawImage(getBallSprite(), -visible.radius, -visible.radius, visible.radius * 2, visible.radius * 2);
        }
        overlay.restore();
        overlayDirty = true;
    }

    function render() {
        if (destroyed || document.hidden) return;
        const bounds = canvas.getBoundingClientRect();
        const {width, height} = bounds.width && bounds.height ? bounds : overlayCanvas?.getBoundingClientRect() || bounds;
        hasViewport = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
        if (!hasViewport) {
            setActive(false);
            clearOverlay();
            return;
        }
        if (ball) ballBottomInset = parseFloat(getComputedStyle(canvas.parentElement).getPropertyValue('--controls-height')) || 71;
        if (gl && !failed && !lost) {
            try {
                resizeCanvas(canvas, width, height, maxSize);
                gl.viewport(0, 0, canvas.width, canvas.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.useProgram(program);
                gl.uniformMatrix4fv(projectionLocation, false, orthographicProjection(width, height));
                gl.uniform1f(effectLocation, 0);
                if (crtActive) {
                    const controlsHeight = parseFloat(getComputedStyle(canvas.parentElement).getPropertyValue('--controls-height')) || 71;
                    const flameHeight = Math.min(height, controlsHeight + 24);
                    gl.uniform1f(effectLocation, 1);
                    gl.uniform2f(flameSizeLocation, width, flameHeight);
                    gl.uniform1f(flameTimeLocation, flameTime);
                    drawTexture(emptyTexture, [0, height - flameHeight, width, flameHeight]);
                    const mallow = marshmallowPose(marshmallows.current(), width, height, controlsHeight);
                    if (mallow && !reducedMotion) {
                        // Include the fixed breath source as well as the moving fire and smoke.
                        const sceneTop = Math.max(0, Math.min(mallow.y - mallow.size * 3.2,
                            mallow.breathOriginY - mallow.size));
                        const sceneHeight = height - sceneTop;
                        gl.uniform1f(effectLocation, 2);
                        gl.uniform2f(flameSizeLocation, width, sceneHeight);
                        gl.uniform4f(marshmallowLocation, mallow.x, mallow.y - height + sceneHeight, mallow.size, mallow.angle);
                        gl.uniform4f(toastingLocation, mallow.toast, mallow.char, mallow.fire, mallow.smoke);
                        gl.uniform4f(stickLocation, mallow.side, mallow.shaft, mallow.blow, mallow.breathTime);
                        gl.uniform4f(breathPathLocation, mallow.breathOriginX, mallow.breathOriginY - sceneTop,
                            mallow.breathTargetX, mallow.breathTargetY - sceneTop);
                        drawTexture(emptyTexture, [0, height - sceneHeight, width, sceneHeight]);
                    }
                    gl.uniform1f(effectLocation, 0);
                }
                drawGhost(getGhostRect(width, height));
                if (ball) {
                    if (!ballTexture) {
                        ballTexture = createTexture();
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, getBallSprite());
                    }
                    const visible = displayBeachBall(ball, width, height, ballBottomInset);
                    drawTexture(ballTexture, [visible.x - visible.radius, visible.y - visible.radius, visible.radius * 2, visible.radius * 2], 0.96, visible.angle);
                }
                if (!active && gl.getError() !== gl.NO_ERROR) throw new Error('Effect rendering failed.');
                setActive(true);
            } catch { /* A texture upload failure must not interrupt room playback. */
                fail();
            }
        } else {
            setActive(false);
        }
        if (active) clearOverlay();
        else renderOverlay(width, height);
    }

    function schedule() {
        if (destroyed || document.hidden) return;
        const canRender = gl && !failed && !lost;
        const animateBall = ball && !reducedMotion && hasViewport;
        const animateFlames = canRender && crtActive && !reducedMotion && hasViewport;
        if (animateBall || animateFlames) {
            if (animationId === null) animationId = requestAnimationFrame(animate);
        } else if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        if (!animateBall) lastBallTime = null;
        if (!animateFlames) lastFlameTime = null;
    }

    function animate(time) {
        animationId = null;
        if (destroyed || document.hidden) return;
        if (crtActive && !reducedMotion) {
            if (lastFlameTime !== null) {
                const elapsed = Math.min(0.05, Math.max(0, (time - lastFlameTime) / 1000));
                flameTime = (flameTime + elapsed) % 256;
                marshmallows.advance(elapsed);
            }
            lastFlameTime = time;
        }
        if (ball && !reducedMotion) {
            const elapsed = lastBallTime === null ? 0 : Math.min(0.05, Math.max(0, (time - lastBallTime) / 1000));
            ball = advanceBeachBall(ball, elapsed, reducedMotion);
            lastBallTime = time;
        }
        redraw();
    }

    function redraw() {
        render();
        schedule();
    }

    function reset() {
        cancelFrame();
        redraw();
    }

    function visibilityChanged() {
        cancelFrame();
        if (!document.hidden) redraw();
    }

    function motionChanged() {
        reducedMotion = !!motionQuery.matches;
        cancelFrame();
        redraw();
    }

    function contextLost(event) {
        event.preventDefault();
        lost = true;
        cancelFrame();
        setActive(false);
        disposeResources();
        redraw();
    }

    function contextRestored() {
        lost = false;
        initialize();
        redraw();
    }

    const events = ['loadedmetadata', 'loadeddata', 'seeked', 'resize'];
    function setVideo(next) {
        for (const event of events) video?.removeEventListener(event, redraw);
        video?.removeEventListener('emptied', reset);
        video = next;
        for (const event of events) video?.addEventListener(event, redraw);
        video?.addEventListener('emptied', reset);
    }
    setVideo(video);
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('webglcontextrestored', contextRestored);
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('resize', redraw);
    if (motionQuery?.addEventListener) motionQuery.addEventListener('change', motionChanged);
    else motionQuery?.addListener(motionChanged);
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    if (overlayCanvas) observer.observe(overlayCanvas);
    if (gl) initialize();
    else onActive(false);
    redraw();

    return {
        setVideo(next) { if (next !== video) setVideo(next); },
        setCrtActive(value) {
            if (destroyed || crtActive === !!value) return;
            crtActive = !!value;
            lastFlameTime = null;
            marshmallows.reset();
            redraw();
        },
        setGhost(imageOrNull) {
            if (destroyed) return;
            ghost = imageOrNull || null;
            ghostDirty = !!ghost;
            if (!ghost && ghostTexture) {
                if (gl && !lost) gl.deleteTexture(ghostTexture);
                ghostTexture = null;
            }
            redraw();
        },
        setBeachBallState(snapshot, elapsed = 0) {
            if (destroyed || (!snapshot && !ball)) return;
            if (snapshot) ball = advanceBeachBall(snapshot, Math.max(0, Math.min(0.1, elapsed)));
            else releaseBall();
            lastBallTime = null;
            redraw();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            cancelFrame();
            observer.disconnect();
            setVideo(null);
            canvas.removeEventListener('webglcontextlost', contextLost);
            canvas.removeEventListener('webglcontextrestored', contextRestored);
            document.removeEventListener('visibilitychange', visibilityChanged);
            window.removeEventListener('resize', redraw);
            if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', motionChanged);
            else motionQuery?.removeListener(motionChanged);
            clearOverlay();
            ghost = null;
            releaseBall();
            disposeResources();
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
        },
    };
}

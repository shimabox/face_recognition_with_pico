document.addEventListener('DOMContentLoaded', function () {
    /**
     | -------------------------------------------------------------------------
     | params
     | -------------------------------------------------------------------------
     */
    // video canvas size(4:3)
    const video_canvas_w = 640; // default 640
    const video_canvas_h = Math.round(video_canvas_w * (3 / 4)); // default 480

    // cascade params
    const min_size_of_cascade_param = 30;

    // 顔画像キャプチャー先canvasのサイズ係数
    const cliped_size_factor = 1.0;

    // cliped_canvas context
    const lw = 4; // lineWidth
    const ss = 'rgba(0, 255, 0, 0.6)'; // strokeStyle

    /**
     | -------------------------------------------------------------------------
     | 前処理
     | -------------------------------------------------------------------------
     */
    // video
    let video    = document.getElementById('camera');
    video.width  = video_canvas_w;
    video.height = video_canvas_h;

    // canvas
    let video_canvas     = document.getElementById('from-video');
    let video_canvas_ctx = video_canvas.getContext('2d');
    video_canvas.width   = video_canvas_w;
    video_canvas.height  = video_canvas_h;

    // dummy wrapper
    let dummy_box = document.getElementById('dummy-box');

    // video constraints
    const video_constraints_for_front = {video: {facingMode : "user"}};
    const video_constraints_for_rear  = {video: {facingMode : {exact : "environment"}}};
    let video_track = null;

    // カメラ切り替え
    const facing_mode = document.getElementById('facing-mode');
    let is_front = facing_mode.value !== "0";
    facing_mode.addEventListener('change', function(e){
        is_front = this.checked;

        if (video_track) {
            video_track.stop();
        }

        video_track = null;
        video.srcObject = null;

        // Reload video
        load();
    });

    // グレースケール変換
    const for_grayscale = document.getElementById('to-grayscale');
    let switch_grayscale = for_grayscale.value !== "0";
    for_grayscale.addEventListener('change', function(e){
        switch_grayscale = this.checked;
    });

    // debug用
    const for_debug = document.getElementById('debug');
    let is_debug = for_debug.value !== "0";
    for_debug.addEventListener('change', function(e){
        is_debug = this.checked;
    });

    // 顔部分のマージン設定
    let adjustment_of_x; // x座標の調整 = -15;
    let adjustment_of_y; // y座標の調整 = -15;
    let adjustment_of_w; // 横幅の調整  = Math.abs(adjustment_of_x * 2);
    let adjustment_of_h; // 縦幅の調整  = Math.abs(adjustment_of_y * 2);

    // @lenk https://beiznotes.org/input-range-show-value/
    // スライダーの値
    const range_elem = document.getElementsByClassName('range');

    const apply_range_val = function(elem, target) {
        return function(evt) {
            setting_face_margin();
            target.innerHTML = elem.value;
        }
    }

    function setting_face_margin() {
        // @link https://blog.sushi.money/entry/2017/04/19/114028
        Array.from(range_elem, function(range) {
            const bar = range.querySelector('input');
            switch (bar.id) {
                case 'adjustment_of_x':
                    adjustment_of_x = -bar.value;
                    adjustment_of_w = Math.abs(bar.value * 2);
                    break;
                case 'adjustment_of_y':
                    adjustment_of_y = -bar.value;
                    adjustment_of_h = Math.abs(bar.value * 2);
                    break;
            }
        });
    }

    function init_face_margin() {
        setting_face_margin();

        for(let i = 0, len = range_elem.length; i < len; i++){
            let range = range_elem[i];
            let bar = range.querySelector('input');
            let target = range.querySelector('span > span.range-val');
            bar.addEventListener('input', apply_range_val(bar, target));
            target.innerHTML = bar.value;
        }
    }

    /**
     | -------------------------------------------------------------------------
     | statrt
     | -------------------------------------------------------------------------
     */

    init_face_margin();

    /*
        (1) prepare the pico.js face detector
    */
    let facefinder_classify_region = function(r, c, s, pixels, ldim) {return -1.0;};
    const cascadeurl = 'https://raw.githubusercontent.com/nenadmarkus/pico/c2e81f9d23cc11d1a612fd21e4f9de0921a5d0d9/rnt/cascades/facefinder';
    fetch(cascadeurl).then(function(response) {
        response.arrayBuffer().then(function(buffer) {
            let bytes = new Int8Array(buffer);
            facefinder_classify_region = pico.unpack_cascade(bytes);
            console.log('* cascade loaded');

            /*
                (4) instantiate camera handling
            */
            load();
        })
    })

    /*
        (2) get the drawing context on the canvas and define a function to transform an RGBA image to grayscale
    */
    function rgba_to_grayscale(rgba, nrows, ncols) {
        let gray = new Uint8Array(nrows*ncols);
        for(let r=0; r<nrows; ++r)
            for(let c=0; c<ncols; ++c)
                // gray = 0.2*red + 0.7*green + 0.1*blue
                gray[r*ncols + c] = (2*rgba[r*4*ncols+4*c+0]+7*rgba[r*4*ncols+4*c+1]+1*rgba[r*4*ncols+4*c+2])/10;
        return gray;
    }

    /*
        (3) this function is called each time a video frame becomes available
    */
    const update_memory = pico.instantiate_detection_memory(5); // we will use the detecions of the last 5 frames
    const processfn = function(video, dt) {
        // render the video frame to the canvas element and extract RGBA pixel data
        const vcw = video_canvas.width;
        const vch = video_canvas.height;
        const long_side = vcw >= vch ? vcw : vch;

        video_canvas_ctx.clearRect(0, 0, vcw, vch);
        video_canvas_ctx.drawImage(video, 0, 0, vcw, vch);

        let rgba = video_canvas_ctx.getImageData(0, 0, vcw, vch).data;

        // prepare input to `run_cascade`
        let image = {
            "pixels": rgba_to_grayscale(rgba, vch, vcw),
            "nrows": vch,
            "ncols": vcw,
            "ldim": vcw
        }

        let params = {
            "shiftfactor": 0.1, // move the detection window by 10% of its size
            "minsize": min_size_of_cascade_param, // minimum size of a face
            "maxsize": long_side, // maximum size of a face
            "scalefactor": 1.1 // for multiscale processing: resize the detection window by 10% when moving to the higher scale
        }

        // run the cascade over the frame and cluster the obtained detections
        // dets is an array that contains (r, c, s, q) quadruplets
        // (representing row, column, scale and detection score)
        let dets = pico.run_cascade(image, facefinder_classify_region, params);
        dets = update_memory(dets);
        dets = pico.cluster_detections(dets, 0.2); // set IoU threshold to 0.2

        // List with accurate score.
        let list_with_accurate_score = [];

        dets.filter(function(_dets, i) {
            // check the detection score
            // if it's above the threshold, draw it
            // (the constant 50.0 is empirical: other cascades might require a different one)
            if (_dets[3] > 50.0) {
                list_with_accurate_score.push(_dets);
            }
        });

        // 検出スコアの降順にソート
        list_with_accurate_score.sort(function(a, b){
            if(a[3] > b[3]) return -1;
            if(a[3] < b[3]) return 1;
            return 0;
        });

        // 一旦消去
        clear_cliped_canvas();

        for (let i=0;i<list_with_accurate_score.length;++i) {
            render_cliped_canvas(list_with_accurate_score, i);
        }

        _stats();
    }

    function load() {
        const constraints = is_front ? video_constraints_for_front : video_constraints_for_rear;

        swith_scaleX(video_canvas);

        navigator.mediaDevices.getUserMedia(constraints)
        .then(load_success)
        .catch(load_fail);
    }

    function load_success(stream) {
        video_track = stream.getVideoTracks()[0];
        video.srcObject = stream;
    }

    function load_fail(err) {
        alert(err);
        console.log(err);
    }

    function swith_scaleX(elem) {
        const scale_x_val = is_front ? -1 : 1;
        elem.style.transform  = `scaleX(${scale_x_val})`;
    }

    // 動画再生のイベント監視
    let tracking_started = false;
    video.addEventListener('playing', function(){
        if (tracking_started === true) {
            return;
        }

        adjust_proportions();
        draw_loop();

        video.onresize = function() {
            adjust_proportions();
        }

        tracking_started = true;
    });

    function adjust_proportions() {
        // resize overlay and video if proportions of video are not 4:3
        // keep same height, just change width
        const proportion = video.videoWidth / video.videoHeight;
        const video_width = Math.round(video.height * proportion);

        video.width = video_width;
        video_canvas.width = video_width;
    }

    const draw_loop = function() {
        let last = Date.now();
        const loop = function() {
            // For some effects, you might want to know how much time is passed
            // since the last frame; that's why we pass along a Delta time `dt`
            // variable (expressed in milliseconds)
            // (see https://github.com/cbrandolino/camvas)
            let dt = Date.now() - last;
            processfn(video, dt);
            last = Date.now();
            requestAnimationFrame(loop);
        };

        loop();
    }

    /**
     * render cliped_canvas
     */
    function render_cliped_canvas(dets, i) { // dets == pico.cluster_detections()
        const vcw = video_canvas.width;
        const vch = video_canvas.height;

        const x = Math.round(dets[i][1]);
        const y = Math.round(dets[i][0]);
        const w = Math.round(dets[i][2]);

        // transform: scaleX(-1); している場合sxとswの関係性が逆転します
        let sx = Math.round(x - w/2 + adjustment_of_x);
        let sy = Math.round(y - w/2 + adjustment_of_y);
        let sw = w + adjustment_of_w;
        let sh = w + adjustment_of_h;

        // 画面上に顔切り取り部分が見切れた場合
        if (sy < 0) {
            sy += Math.abs(sy);
        }

        // 画面下に顔切り取り部分が見切れた場合
        if (sy + sh > vch) {
            sy -= (sy + sh) - vch;
        }

        // 画面左に顔切り取り部分が見切れた場合
        if (sx + sw > vcw) {
            sx -= (sx + sw) - vcw;
        }

        // 画面右に顔切り取り部分が見切れた場合
        if (sx < 0) {
            sx += Math.abs(sx);
        }

        video_canvas_ctx.beginPath();
        video_canvas_ctx.lineWidth = lw;
        video_canvas_ctx.strokeStyle = ss;
        video_canvas_ctx.strokeRect(sx, sy, sw, sh);
        video_canvas_ctx.stroke();

        if (is_debug) {
            // 円
            video_canvas_ctx.beginPath();
            video_canvas_ctx.lineWidth = lw;
            video_canvas_ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
            video_canvas_ctx.arc(x, y, w / 2, 0, 2 * Math.PI, false);
            video_canvas_ctx.stroke();

            dummy_box.style.display = 'block';
        } else {
            dummy_box.style.display = 'none';
        }

        const ccw = Math.round(sw * cliped_size_factor);
        const cch = Math.round(sh * cliped_size_factor);

        const container = document.querySelector('.cliped-container');
        const cic_list = document.querySelectorAll('[class^=cliped-img-]'); // <canvas class="cliped-img-*" />
        const cic_list_len = cic_list.length;
        const class_name = 'cliped-img-' + (i + 1);

        let cic = document.querySelector('.' + class_name);

        if (cic === null) {
            cic = document.createElement('canvas');
            cic.classList.add(class_name);
            container.appendChild(cic);
        }

        swith_scaleX(cic);
        cic.width  = ccw;
        cic.height = cch;

        let cic_ctx = cic.getContext('2d');
        cic_ctx.clearRect(0, 0, cic.width, cic.height);
        cic_ctx.drawImage(video_canvas, sx + lw, sy + lw, sw - (lw*2), sh - (lw*2), 0, 0, ccw, cch);

        if (switch_grayscale === true) {
            to_grayscale(cic, cic_ctx);
        }
    }

    /**
     * グレースケール変換
     * @link https://www.html5canvastutorials.com/advanced/html5-canvas-grayscale-image-colors-tutorial/
     */
    function to_grayscale(canvas, context) {
        let image_data = context.getImageData(0, 0, canvas.width, canvas.height);
        let data = image_data.data;

        for(let i = 0; i < data.length; i += 4) {
          let brightness = 0.34 * data[i] + 0.5 * data[i + 1] + 0.16 * data[i + 2];
          // red
          data[i] = brightness;
          // green
          data[i + 1] = brightness;
          // blue
          data[i + 2] = brightness;
        }

        // overwrite original image
        context.putImageData(image_data, 0, 0);
    }

    /**
     * clear cliped_canvas
     */
    function clear_cliped_canvas() {
        let cic_list = document.querySelectorAll('[class^=cliped-img-]');
        let cic_list_len = cic_list.length;
        dummy_box.style.display = 'none';

        if (cic_list_len < 1) {
            return;
        }

        do {
            cic_list[cic_list_len - 1].remove();
        } while(--cic_list_len);
    }

    /******** stats ********/
    function _stats() {
        body.dispatchEvent(event);
    }
    const body = document.querySelector('body');
    // Create the event.
    const event = document.createEvent('Event');
    // Define that the event name is 'build'.
    event.initEvent('processfn', true, true);

    const stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '0px';
    body.appendChild(stats.domElement);

    // update stats on every iteration
    document.addEventListener('processfn', function(event) {
        stats.update();
    }, false);
});

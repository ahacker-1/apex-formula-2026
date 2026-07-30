import { Vector2 } from 'three';
import { ShaderPass } from './ShaderPass.js';

// A compact FXAA pass for composer render targets. WebGLRenderer's native
// antialiasing only applies to the default framebuffer, so it cannot smooth the
// final image once the scene is routed through post-processing.
const FXAAShader = {

	name: 'FXAAShader',

	uniforms: {

		'tDiffuse': { value: null },
		'resolution': { value: new Vector2( 1 / 1024, 1 / 512 ) }

	},

	vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,

	fragmentShader: /* glsl */`

		uniform sampler2D tDiffuse;
		uniform vec2 resolution;

		varying vec2 vUv;

		void main() {

			vec3 rgbNW = texture2D( tDiffuse, vUv + vec2( -1.0, -1.0 ) * resolution ).rgb;
			vec3 rgbNE = texture2D( tDiffuse, vUv + vec2( 1.0, -1.0 ) * resolution ).rgb;
			vec3 rgbSW = texture2D( tDiffuse, vUv + vec2( -1.0, 1.0 ) * resolution ).rgb;
			vec3 rgbSE = texture2D( tDiffuse, vUv + vec2( 1.0, 1.0 ) * resolution ).rgb;
			vec4 center = texture2D( tDiffuse, vUv );
			vec3 lumaWeights = vec3( 0.299, 0.587, 0.114 );
			float lumaNW = dot( rgbNW, lumaWeights );
			float lumaNE = dot( rgbNE, lumaWeights );
			float lumaSW = dot( rgbSW, lumaWeights );
			float lumaSE = dot( rgbSE, lumaWeights );
			float lumaM = dot( center.rgb, lumaWeights );
			float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
			float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

			vec2 direction;
			direction.x = - ( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) );
			direction.y = ( lumaNW + lumaSW ) - ( lumaNE + lumaSE );

			float directionReduce = max(
				( lumaNW + lumaNE + lumaSW + lumaSE ) * ( 0.25 * 0.03125 ),
				0.0078125
			);
			float inverseDirectionMin = 1.0 / ( min( abs( direction.x ), abs( direction.y ) ) + directionReduce );
			direction = clamp( direction * inverseDirectionMin, vec2( -8.0 ), vec2( 8.0 ) ) * resolution;

			vec3 rgbA = 0.5 * (
				texture2D( tDiffuse, vUv + direction * ( 1.0 / 3.0 - 0.5 ) ).rgb +
				texture2D( tDiffuse, vUv + direction * ( 2.0 / 3.0 - 0.5 ) ).rgb
			);
			vec3 rgbB = rgbA * 0.5 + 0.25 * (
				texture2D( tDiffuse, vUv + direction * -0.5 ).rgb +
				texture2D( tDiffuse, vUv + direction * 0.5 ).rgb
			);
			float lumaB = dot( rgbB, lumaWeights );
			vec3 color = ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB;

			gl_FragColor = vec4( color, center.a );

		}`

};

class FXAAPass extends ShaderPass {

	constructor() {

		super( FXAAShader );
		this.material.toneMapped = false;

	}

	setSize( width, height ) {

		this.uniforms.resolution.value.set(
			1 / Math.max( 1, width ),
			1 / Math.max( 1, height )
		);

	}

}

export { FXAAPass };

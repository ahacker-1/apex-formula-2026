import { GTAOPass } from './GTAOPass.js';

function normalizeScale( scale ) {

	return Math.min( 1, Math.max( 0.25, Number.isFinite( scale ) ? scale : 0.5 ) );

}

// GTAO is bandwidth-heavy and does not need to match the final color buffer.
// Keep its normal/depth, AO and denoise targets at a controlled fraction of the
// composer resolution while retaining GTAOPass's normal public interface.
class ScaledGTAOPass extends GTAOPass {

	constructor( scene, camera, width, height, resolutionScale = 0.5, parameters ) {

		const scale = normalizeScale( resolutionScale );
		const fullWidth = Math.max( 1, width || 512 );
		const fullHeight = Math.max( 1, height || 512 );
		super(
			scene,
			camera,
			Math.max( 1, Math.ceil( fullWidth * scale ) ),
			Math.max( 1, Math.ceil( fullHeight * scale ) ),
			parameters
		);
		this.resolutionScale = scale;
		this.fullResolutionWidth = fullWidth;
		this.fullResolutionHeight = fullHeight;

	}

	setResolutionScale( resolutionScale ) {

		const scale = normalizeScale( resolutionScale );
		if ( scale === this.resolutionScale ) return;
		this.resolutionScale = scale;
		this.setSize( this.fullResolutionWidth, this.fullResolutionHeight );

	}

	setSize( width, height ) {

		this.fullResolutionWidth = Math.max( 1, width );
		this.fullResolutionHeight = Math.max( 1, height );
		const scale = normalizeScale( this.resolutionScale );
		super.setSize(
			Math.max( 1, Math.ceil( this.fullResolutionWidth * scale ) ),
			Math.max( 1, Math.ceil( this.fullResolutionHeight * scale ) )
		);

	}

	dispose() {

		super.dispose();
		// GTAOPass r160 omits these two owned shader materials from dispose().
		this.gtaoMaterial.dispose();
		this.blendMaterial.dispose();

	}

}

export { ScaledGTAOPass };

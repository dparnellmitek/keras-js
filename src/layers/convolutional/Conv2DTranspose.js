import Layer from '../../Layer'
import Tensor from '../../Tensor'
import * as activations from '../../activations'
import { webgl2 } from '../../WebGL2'
import * as tensorUtils from '../../utils/tensorUtils'
import ops from 'ndarray-ops'
import gemm from 'ndarray-gemm'
import matMulProgramSource from '../../webgl/matMul.glsl'
import convTransposeProgramSource from './Conv2DTranspose.glsl'
import * as activationProgramSources from '../../activations/programSources'

/**
 * Conv2DTranspose layer class
 */
export default class Conv2DTranspose extends Layer {
  /**
   * Creates a Conv2DTranspose layer
   *
   * @param {Object} [attrs] - layer config attributes
   * @param {number} [attrs.filters] - Number of convolution filters to use.
   * @param {number|number[]} [attrs.kernel_size] - Size of the convolution kernel.
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'Conv2DTranspose'

    const {
      filters = 1,
      kernel_size = [3, 3],
      strides = [1, 1],
      padding = 'valid',
      data_format = 'channels_last',
      activation = 'linear',
      use_bias = true
    } = attrs

    if (Array.isArray(kernel_size)) {
      this.kernelShape = [filters, ...kernel_size]
    } else {
      this.kernelShape = [filters, kernel_size, kernel_size]
    }

    if (Array.isArray(strides)) {
      this.strides = strides
    } else {
      this.strides = [strides, strides]
    }

    if (padding === 'valid' || padding === 'same') {
      this.padding = padding
    } else {
      this.throwError('Invalid padding.')
    }

    if (data_format === 'channels_last' || data_format === 'channels_first') {
      this.dataFormat = data_format
    } else {
      this.throwError('Only channels_last and channels_first data formats are allowed.')
    }

    this.activation = activation
    this.activationFunc = activations[activation]

    this.use_bias = use_bias

    // Layer weights specification
    this.params = this.use_bias ? ['kernel', 'bias'] : ['kernel']

    // GPU setup
    if (this.gpu) {
      this.matMulProgram = webgl2.compileProgram(matMulProgramSource)
      this.convTransposeProgram = webgl2.compileProgram(convTransposeProgramSource)
      this.activationProgram = webgl2.compileProgram(activationProgramSources[this.activation])
    }
  }

  /**
   * Method for setting layer weights. Extends `super` method.
   *
   * W weight tensor is converted to `channels_last` mode if in `channels_first` mode.
   *
   * In `channels_last` mode, W weight tensor has shape [nbRow, nbCol, inputChannels, nbFilter]
   *
   * In `channels_first` mode, W weight tensor has shape [nbFilter, inputChannels, nbRow, nbCol]
   *
   * @param {Tensor[]} weightsArr - array of weights which are instances of Tensor
   */
  setWeights(weightsArr) {
    if (this.dataFormat === 'channels_first') {
      weightsArr[0].tensor = weightsArr[0].tensor.transpose(2, 3, 1, 0)
    }
    super.setWeights(weightsArr, false)

    this._w2row()

    if (this.gpu) {
      this.weights['kernel'] = this.wRowsMat
      this.weights['kernel'].createGLTexture({ type: '2d', format: 'float' })
      if (this.use_bias) {
        this.weights['bias'].createGLTexture({ type: '2d', format: 'float' })
      }
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * Method for computing output dimensions and padding, based on input dimensions, kernel size, and padding mode.
   *
   * For tensorflow implementation of padding, see:
   * https://github.com/tensorflow/tensorflow/blob/master/tensorflow/core/framework/common_shape_fns.cc
   *
   * For deconvolution, we will "take away" padding from the output rather than add padding to the input.
   *
   * For more details on calculating output shapes and padding for transposed convolutions (deconvolution here), see:
   * https://arxiv.org/pdf/1603.07285v1.pdf
   *
   * @param {number[]} inputShape
   */
  _calcOutputShape(inputShape) {
    if (this.outputShape && this.outputPadding) {
      return
    }

    const inputRows = inputShape[0]
    const inputCols = inputShape[1]
    const [nbFilter, nbRow, nbCol] = this.kernelShape

    const outputRows =
      this.padding === 'same'
        ? inputRows * this.strides[0]
        : inputRows * this.strides[0] + Math.max(nbRow - this.strides[0], 0)
    const outputCols =
      this.padding === 'same'
        ? inputCols * this.strides[1]
        : inputCols * this.strides[1] + Math.max(nbCol - this.strides[1], 0)
    const outputChannels = nbFilter

    const paddingRow =
      this.padding === 'same' ? Math.max(0, Math.floor((inputRows - 1) * this.strides[0] + nbRow - outputRows)) : 0
    const paddingCol =
      this.padding === 'same' ? Math.max(0, Math.floor((inputCols - 1) * this.strides[1] + nbCol - outputCols)) : 0
    const paddingRowBefore = Math.floor(paddingRow / 2)
    const paddingRowAfter = paddingRow - paddingRowBefore
    const paddingColBefore = Math.floor(paddingCol / 2)
    const paddingColAfter = paddingCol - paddingColBefore

    this.outputShape = [outputRows, outputCols, outputChannels]
    this.outputPadding = [paddingRowBefore, paddingRowAfter, paddingColBefore, paddingColAfter]
  }

  /**
   * Convert input image to column matrix, along channels axis
   *
   * shape: [inputRows, inputCols, inputChannels] -> [inputRows * inputCols, inputChannels]
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  _im2col(x) {
    const [inputRows, inputCols, inputChannels] = x.tensor.shape

    if (!this.imColsMat) {
      this.imColsMat = new Tensor([], [inputRows * inputCols, inputChannels])
    }

    const channelRaveled = new Tensor([], [inputRows * inputCols])
    const channel = new Tensor([], [inputRows, inputCols])
    for (let c = 0; c < inputChannels; c++) {
      ops.assign(channel.tensor, x.tensor.pick(null, null, c))
      channelRaveled.replaceTensorData(channel.tensor.data)
      ops.assign(this.imColsMat.tensor.pick(null, c), channelRaveled.tensor)
    }

    return this.imColsMat
  }

  /**
   * Convert filter weights to row matrix, along channels axis
   *
   * shape: [nbRow, nbCol, nbFilter, inputChannels] -> [inputChannels, nbRow * nbCol * nbFilter]
   *
   * @returns {Tensor}
   */
  _w2row() {
    const [nbRow, nbCol, nbFilter, inputChannels] = this.weights['kernel'].tensor.shape

    this.wRowsMat = new Tensor([], [inputChannels, nbRow * nbCol * nbFilter])

    const channelRaveled = new Tensor([], [nbRow * nbCol * nbFilter])
    const channel = new Tensor([], [nbRow, nbCol, nbFilter])
    for (let c = 0; c < inputChannels; c++) {
      ops.assign(channel.tensor, this.weights['kernel'].tensor.pick(null, null, null, c))
      channelRaveled.replaceTensorData(channel.tensor.data)
      ops.assign(this.wRowsMat.tensor.pick(c, null), channelRaveled.tensor)
    }

    return this.wRowsMat
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    this.inputShape = x.tensor.shape
    this._calcOutputShape(this.inputShape)
    this._im2col(x)

    const inputRows = x.tensor.shape[0]
    const inputCols = x.tensor.shape[1]
    const [nbFilter, nbRow, nbCol] = this.kernelShape
    const matMul = new Tensor([], [inputRows * inputCols, nbRow * nbCol * nbFilter])

    gemm(matMul.tensor, this.imColsMat.tensor, this.wRowsMat.tensor, 1, 1)

    // add padding which we will take away later
    const [paddingRowBefore, paddingRowAfter, paddingColBefore, paddingColAfter] = this.outputPadding
    this.output = new Tensor([], this.outputShape)
    let outputPadded = new Tensor(
      [],
      [
        this.outputShape[0] + paddingRowBefore + paddingRowAfter,
        this.outputShape[1] + paddingColBefore + paddingColAfter,
        this.outputShape[2]
      ]
    )

    const patchShape = [nbRow, nbCol, nbFilter]
    let patch = new Tensor([], patchShape)
    let patchRaveled = new Tensor([], [nbRow * nbCol * nbFilter])
    let index = 0
    for (let i = 0; i < inputRows; i++) {
      for (let j = 0; j < inputCols; j++) {
        ops.assign(patchRaveled.tensor, matMul.tensor.pick(index, null))
        patch.replaceTensorData(patchRaveled.tensor.data)
        const iOutPos = i * this.strides[0]
        const jOutPos = j * this.strides[1]
        ops.addeq(
          outputPadded.tensor.hi(iOutPos + nbRow, jOutPos + nbCol, this.outputShape[2]).lo(iOutPos, jOutPos, 0),
          patch.tensor
        )
        index += 1
      }
    }

    // remove padding
    ops.assign(
      this.output.tensor,
      outputPadded.tensor
        .hi(this.outputShape[0] + paddingRowBefore, this.outputShape[1] + paddingColBefore, this.outputShape[2])
        .lo(paddingRowBefore, paddingColBefore, 0)
    )

    // bias
    if (this.use_bias) {
      for (let n = 0; n < nbFilter; n++) {
        ops.addseq(this.output.tensor.pick(null, null, n), this.weights['bias'].tensor.get(n))
      }
    }

    this.activationFunc(this.output)

    // convert back to channels_first ordering if necessary
    if (this.dataFormat === 'channels_first') {
      this.output.tensor = this.output.tensor.transpose(2, 0, 1)
    }
  }

  /**
   * In GPU mode, we work directly on 2D-reshaped representations of the tensors. After the matrix multiply step produce
   * matrix Y, the final output Z at coordinate [i,j] will be the summation of a number of elements of the matrix Y.
   * Here, we calculate the indices of matrix Y for each coordinate [i,j] of Z, and encode these index maps as texture
   * arrays.
   */
  _createIndexMap() {
    if (this.rowIndexMap && this.colIndexMap) {
      return
    }

    const inputRows = this.inputShape[0]
    const inputCols = this.inputShape[1]
    const [nbFilter, nbRow, nbCol] = this.kernelShape

    const [paddingRowBefore, paddingRowAfter, paddingColBefore, paddingColAfter] = this.outputPadding

    const indicesMapShape = [...this.outputShape, inputRows * inputCols]
    const indicesMapShapePadded = [
      this.outputShape[0] + paddingRowBefore + paddingRowAfter,
      this.outputShape[1] + paddingColBefore + paddingColAfter,
      this.outputShape[2],
      inputRows * inputCols
    ]
    const outputRowIndicesMap = new Tensor([], indicesMapShape, { type: Int32Array })
    const outputColIndicesMap = new Tensor([], indicesMapShape, { type: Int32Array })
    const outputRowIndicesMapPadded = new Tensor([], indicesMapShapePadded, { type: Int32Array })
    const outputColIndicesMapPadded = new Tensor([], indicesMapShapePadded, { type: Int32Array })
    ops.assigns(outputRowIndicesMap.tensor, -1)
    ops.assigns(outputColIndicesMap.tensor, -1)
    ops.assigns(outputRowIndicesMapPadded.tensor, -1)
    ops.assigns(outputColIndicesMapPadded.tensor, -1)

    const matMulColIndicesPatch = new Tensor([], [nbRow, nbCol, nbFilter, 1], { type: Int32Array })
    for (let i = 0; i < nbRow * nbCol * nbFilter; i++) {
      matMulColIndicesPatch.tensor.data[i] = i
    }

    for (let i = 0; i < inputRows; i++) {
      for (let j = 0; j < inputCols; j++) {
        const matMulRowIndex = i * inputCols + j
        const iOutPos = i * this.strides[0]
        const jOutPos = j * this.strides[1]
        ops.assigns(
          outputRowIndicesMapPadded.tensor
            .hi(iOutPos + nbRow, jOutPos + nbCol, this.outputShape[2], matMulRowIndex + 1)
            .lo(iOutPos, jOutPos, 0, matMulRowIndex),
          matMulRowIndex
        )
        ops.assign(
          outputColIndicesMapPadded.tensor
            .hi(iOutPos + nbRow, jOutPos + nbCol, this.outputShape[2], matMulRowIndex + 1)
            .lo(iOutPos, jOutPos, 0, matMulRowIndex),
          matMulColIndicesPatch.tensor
        )
      }
    }

    // remove padding
    ops.assign(
      outputRowIndicesMap.tensor,
      outputRowIndicesMapPadded.tensor
        .hi(
          this.outputShape[0] + paddingRowBefore,
          this.outputShape[1] + paddingColBefore,
          this.outputShape[2],
          inputRows * inputCols
        )
        .lo(paddingRowBefore, paddingColBefore, 0, 0)
    )
    ops.assign(
      outputColIndicesMap.tensor,
      outputColIndicesMapPadded.tensor
        .hi(
          this.outputShape[0] + paddingRowBefore,
          this.outputShape[1] + paddingColBefore,
          this.outputShape[2],
          inputRows * inputCols
        )
        .lo(paddingRowBefore, paddingColBefore, 0, 0)
    )
    // combine first two dimensions
    const tiledIndicesMapShape = [this.outputShape[0] * this.outputShape[1], this.outputShape[2], inputRows * inputCols]
    this.rowIndexMap = new Tensor([], tiledIndicesMapShape, { type: Int32Array })
    this.colIndexMap = new Tensor([], tiledIndicesMapShape, { type: Int32Array })
    const channelData = new Tensor([], [this.outputShape[2], inputRows * inputCols], { type: Int32Array })
    for (let i = 0; i < this.outputShape[0]; i++) {
      for (let j = 0; j < this.outputShape[1]; j++) {
        ops.assign(channelData.tensor, outputRowIndicesMap.tensor.pick(i, j, null, null))
        ops.assign(this.rowIndexMap.tensor.pick(i * this.outputShape[1] + j, null, null), channelData.tensor)
        ops.assign(channelData.tensor, outputColIndicesMap.tensor.pick(i, j, null, null))
        ops.assign(this.colIndexMap.tensor.pick(i * this.outputShape[1] + j, null, null), channelData.tensor)
      }
    }

    this.rowIndexMap.createGLTexture({ type: '2d_array', format: 'int' })
    this.colIndexMap.createGLTexture({ type: '2d_array', format: 'int' })
  }

  /**
   * GPU call
   *
   * @param {Tensor} x
   */
  _callGPU(x) {
    if (x.is2DReshaped || x.is2DSquareReshaped) {
      this.inputShape = x.originalShape
      this._calcOutputShape(this.inputShape)
    } else {
      this.inputShape = x.tensor.shape
      this._calcOutputShape(this.inputShape)
      this._im2col(x)
      this.imColsMat.createGLTexture({ type: '2d', format: 'float' })
    }

    const input = x.is2DReshaped || x.is2DSquareReshaped ? x : this.imColsMat

    // create output textures if doesn't already exist
    if (!this.outputMatmul) {
      const outputTextureShape = [input.glTextureShape[0], this.weights['kernel'].glTextureShape[1]]
      this.outputMatmul = new Tensor([], outputTextureShape)
      this.outputMatmul.createGLTexture({ type: '2d', format: 'float' })
    }
    if (!this.outputPreactiv) {
      const outputTextureShape = [this.outputShape[0] * this.outputShape[1], this.outputShape[2]]
      this.outputPreactiv = new Tensor([], outputTextureShape)
      this.outputPreactiv.createGLTexture({ type: '2d', format: 'float' })
      this.outputPreactiv.is2DReshaped = true
      this.outputPreactiv.originalShape = this.outputShape
      this.outputPreactiv.indicesForReshaped = tensorUtils.createIndicesFor2DReshaped(this.outputShape, false, -1)
    }
    if (!this.output) {
      const outputTextureShape = [this.outputShape[0] * this.outputShape[1], this.outputShape[2]]
      this.output = new Tensor([], outputTextureShape)
      this.output.createGLTexture({ type: '2d', format: 'float' })
      this.output.is2DReshaped = true
      this.output.originalShape = this.outputShape
      this.output.indicesForReshaped = tensorUtils.createIndicesFor2DReshaped(this.outputShape, false, -1)
    }

    // Matrix Multiply with kernel
    webgl2.runProgram({
      program: this.matMulProgram,
      output: this.outputMatmul,
      inputs: [{ input: input, name: 'A' }, { input: this.weights['kernel'], name: 'B' }],
      uniforms: [{ value: 0, type: 'bool', name: 'addC' }]
    })

    // Tranposed Convolution
    this._createIndexMap()
    const test = new Tensor([], [this.outputShape[0] * this.outputShape[1], this.outputShape[2]])
    ops.assign(test.tensor, this.rowIndexMap.tensor.pick(null, null, 0))
    const convTransposeInputs = [
      { input: this.outputMatmul, name: 'outputMatmul' },
      { input: this.rowIndexMap, name: 'rowIndexMap' },
      { input: this.colIndexMap, name: 'colIndexMap' }
    ]
    if (this.use_bias) {
      convTransposeInputs.push({ input: this.weights['bias'], name: 'bias' })
    }
    webgl2.runProgram({
      program: this.convTransposeProgram,
      output: this.outputPreactiv,
      inputs: convTransposeInputs,
      uniforms: [
        { value: this.use_bias ? 1 : 0, type: 'bool', name: 'use_bias' },
        { value: this.outputShape[0] * this.outputShape[1], type: 'int', name: 'rows' },
        { value: this.outputShape[2], type: 'int', name: 'cols' },
        { value: this.inputShape[0] * this.inputShape[1], type: 'int', name: 'summationLength' }
      ]
    })

    // Activation
    if (this.activation === 'linear') {
      this.output = this.outputPreactiv
    } else {
      webgl2.runProgram({
        program: this.activationProgram,
        output: this.output,
        inputs: [{ input: this.outputPreactiv, name: 'x' }]
      })
    }

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      this.output.reshapeFrom2D()

      // convert back to channels_first ordering if necessary
      if (this.dataFormat === 'channels_first') {
        this.output.tensor = this.output.tensor.transpose(2, 0, 1)
      }
    }
  }
}

jest.mock("@medusajs/framework/workflows-sdk", () => {
  const createStepMock = (_name: string, fn: any) => fn
  const createWorkflowMock = (_name: string, fn: any) => fn
  class StepResponse {
    constructor(public output: any) {}
  }
  class WorkflowResponse {
    constructor(public output: any) {}
  }
  return {
    createStep: createStepMock,
    createWorkflow: createWorkflowMock,
    StepResponse,
    WorkflowResponse,
  }
})

describe("createDhlParcelShipmentWorkflow", () => {
  it("is importable and is a valid workflow object", async () => {
    const mod = await import("..")
    expect(mod.createDhlParcelShipmentWorkflow).toBeDefined()
    expect(typeof mod.createDhlParcelShipmentWorkflow).toBe("function")
  })
})

describe("toRegisterItems", () => {
  it("resolves quantities across the live query.graph shapes", async () => {
    const { toRegisterItems } = await import("..")
    expect(
      toRegisterItems({
        items: [
          { id: "li_1", quantity: 2 },
          { id: "li_2", quantity: undefined, detail: { quantity: 3 } },
          { id: "li_3", quantity: { value: "1", precision: 20 } },
        ],
      })
    ).toEqual([
      { id: "li_1", quantity: 2 },
      { id: "li_2", quantity: 3 },
      { id: "li_3", quantity: 1 },
    ])
  })

  it("drops null elements and unresolvable quantities", async () => {
    const { toRegisterItems } = await import("..")
    expect(
      toRegisterItems({ items: [null, { id: "li_1", quantity: undefined, detail: null }] })
    ).toEqual([])
    expect(toRegisterItems({})).toEqual([])
  })
})

"use client"

import { AntdRegistry } from "@ant-design/nextjs-registry"
import { ConfigProvider } from "antd"
import type { ReactNode } from "react"

import { uiColorTokens } from "./tokens"

const uiTheme = {
  components: {
    Button: {
      borderRadius: 8,
      controlHeight: 44,
    },
    Input: {
      activeBorderColor: uiColorTokens.primary,
      controlHeight: 44,
    },
    Table: {
      headerBg: uiColorTokens.surfaceSunken,
    },
  },
  token: {
    borderRadius: 8,
    colorBgContainer: uiColorTokens.surfaceRaised,
    colorBorder: uiColorTokens.border,
    colorError: uiColorTokens.error,
    colorInfo: uiColorTokens.info,
    colorPrimary: uiColorTokens.primary,
    colorSuccess: uiColorTokens.success,
    colorText: uiColorTokens.textStrong,
    colorTextSecondary: uiColorTokens.textMuted,
    colorWarning: uiColorTokens.warning,
    controlHeight: 44,
  },
} as const

export function UiProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AntdRegistry>
      <ConfigProvider theme={uiTheme}>
        <div data-testid="ui-provider" data-ui-registry="antd">
          {children}
        </div>
      </ConfigProvider>
    </AntdRegistry>
  )
}

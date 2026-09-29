import { Box, HStack } from '@chakra-ui/react'
import type { ReactNode } from 'react'

/** アイコン + 本文の1行(アイコンの分だけ2行目以降を字下げする) */
export function IconLine({
  icon,
  children,
}: {
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <HStack gap={2} align="flex-start">
      <Box pt="2px" flexShrink={0}>
        {icon}
      </Box>
      {/* minW=0とセットで、長いフォルダ名などをこの列の中で折り返させる */}
      <Box flex="1" minW={0} overflowWrap="anywhere">
        {children}
      </Box>
    </HStack>
  )
}


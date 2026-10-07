package com.azzapp.rnskv;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class RgbaLayoutTest {
  @Test public void supportsPackedAndPaddedRowsWithoutRequiringLastRowPadding() {
    assertEquals(638 * 4, RgbaLayout.bytesPerRow(638));
    assertEquals(638 * 358 * 4, RgbaLayout.byteSize(638, 358));
    assertEquals(2560 * 357 + 638 * 4, RgbaLayout.requiredBytes(638, 358, 2560));
  }
  @Test(expected = IllegalArgumentException.class)
  public void rejectsOverflowBeforeAllocating() { RgbaLayout.byteSize(65536, 65536); }
  @Test(expected = IllegalArgumentException.class)
  public void rejectsShortStride() { RgbaLayout.requiredBytes(638, 358, 2000); }
  @Test(expected = IllegalArgumentException.class)
  public void rejectsNegativeDimensions() { RgbaLayout.byteSize(-1, 1080); }
}
